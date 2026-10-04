// ----------------------------------------------------------------------------
// W FLOW — AI provider layer
// Supports OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, custom)
// and Anthropic. Credentials are entered by the user in the UI and stored in
// the local data files (self-hosted).
// ----------------------------------------------------------------------------
import { AI_PROVIDERS } from "../shared/catalog.js";
import { safeFetch } from "./ssrf.js";
import { currentRunContext } from "./run-context.js";
import { runBudget, beforeModelCall, afterModelCall, requestHash, cachedAnswer, saveAnswer } from "./ai-budget.js";

const PROVIDER_DEFAULTS = Object.fromEntries(
  AI_PROVIDERS.map((p) => [p.value, { baseUrl: p.defaultBaseUrl, model: p.defaultModel }])
);

export function resolveConfig(cfg = {}) {
  const defaults = PROVIDER_DEFAULTS[cfg.provider] || {};
  const baseUrl = (cfg.baseUrl || "").trim().replace(/\/+$/, "") || defaults.baseUrl || "";
  return {
    provider: cfg.provider || "openai",
    baseUrl,
    apiKey: cfg.apiKey || "",
    model: (cfg.model || "").trim() || defaults.model || "",
    temperature: cfg.temperature ?? 0.7,
    maxTokens: cfg.maxTokens ?? 1024,
    jsonMode: !!cfg.jsonMode,
  };
}

// ----------------------------------------------------------------------------
// OpenAI-compatible chat completions
// ----------------------------------------------------------------------------
async function openaiChat(cfg, messages, opts = {}) {
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (cfg.jsonMode && !opts.tools?.length) {
    body.response_format = { type: "json_object" };
  }
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await safeFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`AI provider error (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls: msg.tool_calls || [],
    usage: data.usage,
    // "length" means the model ran into max_tokens — callers that ask for a
    // whole document (the workflow builder) warn about a possibly cut-off answer.
    finishReason: data.choices?.[0]?.finish_reason || "",
  };
}

// ----------------------------------------------------------------------------
// Anthropic messages API
// ----------------------------------------------------------------------------
async function anthropicChat(cfg, messages, opts = {}) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    messages: rest,
  };
  if (system) body.system = system;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const res = await safeFetch(`${cfg.baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`Anthropic error (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const toolCalls = (data.content || [])
    .filter((c) => c.type === "tool_use")
    .map((c) => ({ id: c.id, function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
  // Anthropic calls the same situation "max_tokens".
  return { text, toolCalls, usage: data.usage, finishReason: data.stop_reason || "" };
}

// ----------------------------------------------------------------------------
// Token usage
//
// Providers report the same numbers under different names — OpenAI-style
// (`prompt_tokens` / `completion_tokens` / `total_tokens`) and Anthropic
// (`input_tokens` / `output_tokens`). One shape everywhere keeps the executor's
// accounting (per-node usage, per-run totals, estimated cost) simple.
// ----------------------------------------------------------------------------
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  // Also accept the already-normalised keys (`prompt` / `completion` / `total`)
  // so running this twice is harmless — the executor re-normalises the merged
  // per-node figure when it folds it into the run's total.
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completion ?? 0) || 0;
  const total = Number(usage.total_tokens ?? usage.total ?? 0) || prompt + completion;
  if (!prompt && !completion && !total) return null;
  // The model rides along when the caller knows it — the run's cost estimate
  // prices each call by model, so dropping it would price everything with the
  // fallback rate.
  const model = String(usage.model ?? "").trim();
  return { prompt, completion, total, ...(model ? { model } : {}) };
}

function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return { prompt: a.prompt + b.prompt, completion: a.completion + b.completion, total: a.total + b.total };
}

// ----------------------------------------------------------------------------
// Every chat call of a workflow run goes through here: a saved answer for an
// identical request is reused when the node allows it (no tokens, so even an
// exhausted budget does not block it), then the run's budgets are checked (and
// may swap in a cheaper model or fewer output tokens), then the call's usage
// is booked (server/ai-budget.js). Outside a run — the builder, "Test
// connection" — there is no budget and this is a plain call.
// ----------------------------------------------------------------------------
async function modelChat(cfg, messages, opts = {}) {
  const budget = await runBudget(currentRunContext().ai);
  const hash = budget?.node?.config?.reuseAnswers && !opts.tools?.length ? requestHash(budget.ownerId, cfg, messages, opts) : null;
  if (hash) {
    const saved = await cachedAnswer(budget, hash);
    if (saved) return { ...saved, usage: null, cached: true };
  }
  const useCfg = await beforeModelCall(budget, cfg);
  const res = useCfg.provider === "anthropic" ? await anthropicChat(useCfg, messages, opts) : await openaiChat(useCfg, messages, opts);
  await afterModelCall(budget, useCfg, res.usage);
  if (hash) await saveAnswer(budget, hash, res);
  // The model that really answered prices the call (it differs after a fallback).
  if (res.usage && typeof res.usage === "object") res.usage = { ...res.usage, model: useCfg.model };
  return res;
}

// ----------------------------------------------------------------------------
// Public: one-shot chat completion
// ----------------------------------------------------------------------------
export async function chatCompletion(rawCfg, messages, opts = {}) {
  const cfg = resolveConfig(rawCfg);
  if (!cfg.baseUrl) throw new Error("No base URL configured for this provider.");
  if (!cfg.model) throw new Error("No model configured.");
  return modelChat(cfg, messages, opts);
}

// ----------------------------------------------------------------------------
// Tools available to agents
// ----------------------------------------------------------------------------
function buildToolDefs(agent) {
  const defs = [];
  const tools = agent.tools || {};
  if (tools.http) {
    defs.push({
      name: "http_request",
      description: "Make an HTTP request to an external API and return the response.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
          url: { type: "string", description: "Full URL of the request" },
          headers: { type: "object", description: "Optional request headers as an object" },
          body: { type: "string", description: "Optional request body (JSON string)" },
        },
        required: ["method", "url"],
      },
    });
  }
  if (tools.time) {
    defs.push({
      name: "current_time",
      description: "Get the current date and time.",
      parameters: { type: "object", properties: {} },
    });
  }
  return defs;
}

async function executeToolCall(agent, name, args) {
  if (name === "current_time") {
    return { now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  if (name === "http_request") {
    const tools = agent.tools || {};
    const method = (args.method || tools.httpMethod || "GET").toUpperCase();
    const url = args.url || tools.httpUrl;
    if (!url) return { error: "No URL provided for http_request tool." };
    let headers = {};
    try {
      headers = args.headers || (tools.httpHeaders ? JSON.parse(tools.httpHeaders) : {});
    } catch {
      headers = {};
    }
    let body;
    try {
      body = args.body !== undefined ? JSON.parse(args.body) : tools.httpBody ? JSON.parse(tools.httpBody) : undefined;
    } catch {
      body = args.body;
    }
    const res = await safeFetch(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { status: res.status, ok: res.ok, data };
  }
  return { error: `Unknown tool: ${name}` };
}

// ----------------------------------------------------------------------------
// Agent loop with tool calling (max 6 tool rounds to avoid runaway loops)
// ----------------------------------------------------------------------------
export async function runAgent(agent, history) {
  const cfg = resolveConfig(agent.model);
  const tools = buildToolDefs(agent);
  const toolRuns = [];
  // A tool-calling agent makes several model calls; the run's token usage is
  // the sum of all of them, not just the last round.
  let totalUsage = null;
  const isAnthropic = cfg.provider === "anthropic";
  const system = agent.systemPrompt || "";

  const historyMessages = Array.isArray(history) ? history : [];
  const messages = agent.memory !== false ? historyMessages : historyMessages.slice(-1);

  let msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  if (msgs.length === 0) msgs = [{ role: "user", content: "Hello" }];

  for (let round = 0; round < 6; round++) {
    const res = await modelChat(cfg, [{ role: "system", content: system }, ...msgs], { tools });

    totalUsage = addUsage(totalUsage, normalizeUsage(res.usage));

    if (!res.toolCalls.length) {
      // `model` rides along so the executor can price this run: the agent's
      // model is only known here, not in the workflow node.
      const usage = totalUsage || normalizeUsage(res.usage);
      return { reply: res.text, toolRuns, usage: usage ? { ...usage, model: cfg.model } : null, rounds: round + 1 };
    }

    // Execute requested tools and append results
    if (isAnthropic) {
      msgs.push({ role: "assistant", content: res.text || null });
      const toolResults = [];
      for (const tc of res.toolCalls) {
        const out = await executeToolCall(agent, tc.function.name, JSON.parse(tc.function.arguments || "{}"));
        toolRuns.push({ name: tc.function.name, args: tc.function.arguments, output: out });
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(out) });
      }
      msgs.push({ role: "user", content: toolResults });
    } else {
      msgs.push({ role: "assistant", content: res.text || null, tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const out = await executeToolCall(agent, tc.function.name, JSON.parse(tc.function.arguments || "{}"));
        toolRuns.push({ name: tc.function.name, args: tc.function.arguments, output: out });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
      }
    }
  }
  return { reply: "Agent reached the maximum number of tool rounds.", toolRuns, usage: totalUsage ? { ...totalUsage, model: cfg.model } : null, rounds: 6 };
}

// ----------------------------------------------------------------------------
// Image generation (OpenAI images API)
// ----------------------------------------------------------------------------
export async function generateImage(rawCfg, prompt) {
  const cfg = resolveConfig({ ...rawCfg, provider: rawCfg.provider || "openai" });
  const res = await safeFetch(`${cfg.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model || "gpt-image-1",
      prompt,
      size: rawCfg.size || "1024x1024",
      n: 1,
    }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`Image API error (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  return { url: data.data?.[0]?.url || null, revisedPrompt: data.data?.[0]?.revised_prompt };
}

// ----------------------------------------------------------------------------
// Text embeddings (OpenAI-compatible /embeddings endpoint)
// ----------------------------------------------------------------------------
export async function embedText(rawCfg, text) {
  const cfg = resolveConfig({ ...rawCfg, provider: rawCfg.provider || "openai" });
  if (!cfg.baseUrl) throw new Error("No base URL configured for this provider.");
  // Embeddings cost tokens too — the same budgets apply.
  const budget = await runBudget(currentRunContext().ai);
  await beforeModelCall(budget, cfg);
  const res = await safeFetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model || "text-embedding-3-small", input: String(text ?? "") }),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`Embedding API error (${res.status}): ${t || res.statusText}`);
  }
  const data = await res.json();
  const vector = data.data?.[0]?.embedding || null;
  await afterModelCall(budget, cfg, data.usage);
  return { vector, dimensions: Array.isArray(vector) ? vector.length : 0, usage: data.usage };
}

// ----------------------------------------------------------------------------
// Structured extraction — ask a chat model to return JSON matching a schema
// ----------------------------------------------------------------------------
export async function extractStructured(rawCfg, { text, schema, targetType }) {
  const cfg = resolveConfig(rawCfg);
  const one = schema && typeof schema === "object" ? JSON.stringify(schema) : String(schema || "{}");
  const instruction =
    targetType === "list"
      ? `Return ONLY a JSON array of objects. Each element must match this JSON schema exactly (never include the schema itself): ${one}`
      : `Return ONLY a single JSON object matching this JSON schema exactly (never include the schema itself): ${one}`;
  const messages = [
    { role: "system", content: "You extract structured data into valid JSON exactly as requested. Do not wrap the JSON in markdown fences and output nothing but raw JSON." },
    { role: "user", content: `${instruction}\n\nText to analyze:\n"""\n${text}\n"""` },
  ];
  const res = await chatCompletion(cfg, messages); // jsonMode from config applies for OpenAI-compatible
  return { text: res.text, usage: res.usage };
}

// ----------------------------------------------------------------------------
// Quick connectivity test for the config panel
// ----------------------------------------------------------------------------
export async function testConnection(rawCfg) {
  const res = await chatCompletion(rawCfg, [{ role: "user", content: "Reply with exactly: OK" }]);
  return { ok: true, reply: res.text.slice(0, 200), usage: res.usage };
}

// ----------------------------------------------------------------------------
// Live model list — fetch the models a provider actually exposes using the
// credentials the user entered (used to populate the model dropdown).
// OpenAI-compatible providers expose GET {baseUrl}/models; Anthropic has its
// own /v1/models endpoint.
// ----------------------------------------------------------------------------
export async function listModels(rawCfg) {
  const cfg = resolveConfig(rawCfg);
  if (!cfg.baseUrl) throw new Error("No base URL configured for this provider.");
  const headers = { "Content-Type": "application/json" };
  if (cfg.provider === "anthropic") {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  const res = await safeFetch(`${cfg.baseUrl}/models`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Models API error (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  const ids = list
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((x) => typeof x === "string" && x.trim() !== "");
  return ids;
}
