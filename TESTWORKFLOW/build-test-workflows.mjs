// Builds the 10 TESTWORKFLOW workflow JSON files (single-object, importable).
// Run:  node build-test-workflows.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "workflows");
fs.mkdirSync(OUT, { recursive: true });

let seq = 0;
// unique per file (reset per workflow) node ids like n-1, n-2 …
const makeId = () => `n-${++seq}`;
const resetIds = () => { seq = 0; };

// --- node builders -----------------------------------------------------------
const webhookTrigger = (idc, o = {}) => ({
  id: idc(),
  type: "webhook",
  position: { x: -720, y: 200 },
  data: {
    label: o.label || "Webhook",
    config: {
      inputMode: "auto",
      inputField: "",
      method: o.method || "POST",
      responseMode: "json",
      customResponse: '{\n  "ok": true\n}',
      secret: o.secret || "",
    },
  },
});

const respond = (idc, o = {}) => ({
  id: idc(),
  type: "webhookRespond",
  position: { x: 560, y: 200 },
  data: {
    label: o.label || "Webhook Respond",
    config: {
      status: o.status ?? 200,
      contentType: o.contentType || "json",
      body: o.body != null ? o.body : '{\n  "ok": true\n}',
    },
  },
});

const setNode = (idc, o = {}) => ({
  id: idc(),
  type: "set",
  position: { x: -360, y: 200 },
  data: {
    label: o.label || "Set Fields",
    config: {
      mode: "set",
      parseValues: false,
      fields: o.fields || [{ key: "processed", value: "true" }],
    },
  },
});

const codeNode = (idc, o = {}) => ({
  id: idc(),
  type: "code",
  position: { x: -360, y: 200 },
  data: {
    label: o.label || "Code",
    config: { code: o.code || "return items.map(it => it);", outputFile: o.outputFile || "" },
  },
});

const promptNode = (idc, o = {}) => ({
  id: idc(),
  type: "prompt",
  position: { x: -360, y: 200 },
  data: {
    label: o.label || "Prompt Template",
    config: { template: o.template || "Hello {{name}}", outputField: o.outputField || "prompt" },
  },
});

const extractPdf = (idc, o = {}) => ({
  id: idc(),
  type: "extractFile",
  position: { x: -360, y: 150 },
  data: {
    label: o.label || "Extract PDF Text",
    config: {
      inputMode: "auto",
      inputField: "",
      fileSource: "field",
      sourceField: o.sourceField || "body.pdf",
      sourceFile: "",
      contentMode: "base64",
      fileNameField: "",
      fileName: "upload.pdf",
      outputMode: "text",
      format: "auto",
      delimiter: "auto",
      headerRow: true,
      sheetIndex: 1,
      encoding: "utf-8",
      maxTextLength: 100000,
      maxRows: 1000,
      entryPattern: "",
      maxEntries: 500,
      outputFile: "",
      manualOutput: !!o.manualOutput,
      manualOutputJson: o.manualOutputJson ?? "",
    },
  },
});

const aiAgent = (idc, o = {}) => ({
  id: idc(),
  type: "aiAgent",
  position: { x: -40, y: 150 },
  data: {
    label: o.label || "Analyze With AI",
    config: {
      agentSource: "inline",
      agentId: "",
      provider: o.provider || "groq",
      baseUrl: "",
      apiKey: o.apiKey || "",
      model: o.model || "openai/gpt-oss-120b",
      temperature: 0.2,
      maxTokens: 800,
      systemPrompt: o.systemPrompt || "You are a helpful analysis agent.",
      prompt: o.prompt || "Analyze this text:\n\n{{text}}\n\nIf the text above is empty or missing, do not ask for it again — reply that no text could be extracted from the PDF (it may be a scanned or image-only document).",
      useHttpTool: false,
      httpMethod: "GET",
      httpUrl: "https://api.example.com/data",
      httpHeaders: '{\n  "Content-Type": "application/json"\n}',
      httpBody: "{}",
      useTimeTool: false,
      apiUrl: "",
      apiMethod: "POST",
      apiHeaders: '{\n  "Content-Type": "application/json"\n}',
      apiBody: '{\n  "message": "{{json}}"\n}',
      apiReplyPath: "",
      apiTimeout: 30,
      manualOutput: !!o.manualOutput,
      manualOutputJson:
        o.manualOutputJson !== undefined
          ? o.manualOutputJson
          : '{\n  "reply": "[manual] No tokens available — analysis skipped by user."\n}',
    },
  },
});

const ifNode = (idc, o = {}) => ({
  id: idc(),
  type: "if",
  position: { x: -360, y: 200 },
  data: {
    label: o.label || "IF Condition",
    config: {
      valueA: o.valueA || "{{status}}",
      operator: o.operator || "equals",
      valueB: o.valueB || "success",
      caseSensitive: false,
    },
  },
});

const httpNode = (idc, o = {}) => ({
  id: idc(),
  type: "http",
  position: { x: -360, y: 200 },
  data: {
    label: o.label || "HTTP Request",
    config: {
      method: o.method || "GET",
      url: o.url || "https://api.example.com/data",
      query: [],
      parseAs: "auto",
      followRedirects: true,
      authType: "none",
      authToken: "",
      authUser: "",
      authPass: "",
      headers: '{\n  "Content-Type": "application/json"\n}',
      body: o.body != null ? o.body : '{\n  "message": "{{message}}"\n}',
      timeout: 15,
      retries: 0,
      outputFile: "",
    },
  },
});

const manualTrigger = (idc, o = {}) => ({
  id: idc(),
  type: "manual",
  position: { x: -720, y: 200 },
  data: {
    label: o.label || "Manual Trigger",
    config: {
      inputMode: "auto",
      inputField: "",
      manualOutput: !!o.manualOutput,
      manualOutputJson: o.manualOutputJson ?? "",
    },
  },
});

const edge = (a, b, handle = "out") => ({
  id: `xy-edge__${a.id}${handle}-${b.id}in`,
  source: a.id,
  target: b.id,
  sourceHandle: handle,
  targetHandle: "in",
});

const uuid = (s) => `test-${s}`;

const W = [];

// --- 1. Webhook Echo ---------------------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const s = setNode(idc, { fields: [{ key: "echo", value: "{{body.message}}" }, { key: "processedBy", value: "echo-test" }] });
  const r = respond(idc, { body: '{\n  "received": true,\n  "message": "{{body.message}}"\n}' });
  W.push({
    id: uuid("wf-echo"),
    name: "Test 1 — Webhook Echo (receive → respond)",
    description: "Webhook trigger receives JSON, passes it through a Set node, Webhook Respond sends the message back. No auto-response from the trigger.",
    nodes: [t, s, r],
    edges: [edge(t, s), edge(s, r)],
  });
}

// --- 2. Respond Only ---------------------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const r = respond(idc, { body: '{\n  "ack": true,\n  "source": "{{body.source}}"\n}' });
  W.push({
    id: uuid("wf-respondonly"),
    name: "Test 2 — Respond Only",
    description: "Webhook trigger forwards the body straight to the Webhook Respond node.",
    nodes: [t, r],
    edges: [edge(t, r)],
  });
}

// --- 3. PDF → AI agent → respond (manual output fallback) --------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const e = extractPdf(idc);
  const a = aiAgent(idc, {
    manualOutput: true,
    manualOutputJson: '{\n  "reply": "[manual] The PDF was received. Its analysis was skipped because model tokens are exhausted."\n}',
  });
  const r = respond(idc, { body: '{\n  "analysis": "{{reply}}"\n}' });
  W.push({
    id: uuid("wf-pdfai"),
    name: "Test 3 — PDF Analyzer (webhook → extract → agent → respond)",
    description: "Upload a PDF to the webhook; text is extracted, an AI agent analyzes it (manual output fallback if no tokens), and the respond node returns the analysis.",
    nodes: [t, e, a, r],
    edges: [edge(t, e), edge(e, a), edge(a, r)],
  });
}

// --- 4. Strict sequential ----------------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const s1 = codeNode(idc, { label: "Step 1", code: "return items.map(it => ({ json: { ...it.json, step: 'one', val: (it.json.body?.message || '') + '|1' } }));" });
  const s2 = codeNode(idc, { label: "Step 2", code: "return items.map(it => ({ json: { ...it.json, step: 'two', val: it.json.val + '|2' } }));" });
  const r = respond(idc, { body: '{\n  "final": "{{val}}"\n}' });
  W.push({
    id: uuid("wf-seq"),
    name: "Test 4 — Strict Sequential Chain",
    description: "Webhook → Code(step1) → Code(step2) → respond. Verifies each downstream node waits for its upstream to finish.",
    nodes: [t, s1, s2, r],
    edges: [edge(t, s1), edge(s1, s2), edge(s2, r)],
  });
}

// --- 5. Halt & Run Next Node (manual stepping) -------------------------------
{
  resetIds();
  const idc = makeId;
  const m = manualTrigger(idc, { manualOutput: true, manualOutputJson: '{\n  "status": "success"\n}' });
  const f = ifNode(idc, { valueA: "{{status}}", operator: "equals", valueB: "success" });
  const okCode = codeNode(idc, { label: "Success path", code: "return items.map(it => ({ json: { ...it.json, branch: 'success' } }));" });
  const failCode = codeNode(idc, { label: "Failure path", code: "return items.map(it => ({ json: { ...it.json, branch: 'failure' } }));" });
  W.push({
    id: uuid("wf-haltstep"),
    name: "Test 5 — Halt & Run Next Node (manual output)",
    description: "Manual trigger feeds fixed data; an IF node evaluates it; he branch is triggered via 'Run next node' using manual output to step past a halted node.",
    nodes: [m, f, okCode, failCode],
    edges: [edge(m, f), edge(f, okCode, "true"), edge(f, failCode, "false")],
  });
}

// --- 6. Prompt template + respond --------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const p = promptNode(idc, { template: "Hello {{body.name}}, your status is: {{body.status}}", outputField: "prompt" });
  const r = respond(idc, { body: '{\n  "prompt": "{{prompt}}"\n}' });
  W.push({
    id: uuid("wf-template"),
    name: "Test 6 — Prompt Template → Webhook Respond",
    description: "Webhook → Prompt Template builds a string from the payload → respond node returns the rendered prompt.",
    nodes: [t, p, r],
    edges: [edge(t, p), edge(p, r)],
  });
}

// --- 7. Branching IF ---------------------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const f = ifNode(idc, { valueA: "{{body.status}}", operator: "equals", valueB: "success" });
  const ok = respond(idc, { label: "Respond Success", body: '{\n  "result": "SUCCESS"\n}' });
  const no = respond(idc, { label: "Respond Failure", body: '{\n  "result": "FAILURE"\n}' });
  W.push({
    id: uuid("wf-branch"),
    name: "Test 7 — Branching (IF → success / failure respond)",
    description: "Webhook → IF on {{status}}. The true branch reaches a 'SUCCESS' respond node; the false branch a 'FAILURE' respond node. Only the executed branch responds.",
    nodes: [t, f, ok, no],
    edges: [edge(t, f), edge(f, ok, "true"), edge(f, no, "false")],
  });
}

// --- 8. HTTP request then respond --------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)" });
  const h = httpNode(idc, { method: "GET", url: "https://httpbin.org/status/200" });
  const r = respond(idc, { body: '{\n  "httpStatus": "called"\n}' });
  W.push({
    id: uuid("wf-http"),
    name: "Test 8 — HTTP Request → Webhook Respond",
    description: "Webhook → an HTTP GET to a public API → respond node returns a fixed status.",
    nodes: [t, h, r],
    edges: [edge(t, h), edge(h, r)],
  });
}

// --- 9. Secret-protected webhook ---------------------------------------------
{
  resetIds();
  const idc = makeId;
  const t = webhookTrigger(idc, { label: "Webhook (Receive)", secret: "s3cret" });
  const r = respond(idc, { body: '{\n  "authorized": true\n}' });
  W.push({
    id: uuid("wf-secret"),
    name: "Test 9 — Secret-Protected Webhook",
    description: "Webhook trigger requires X-W-Flow-Secret 's3cret'; without it the request is rejected 401; with it the respond node answers.",
    nodes: [t, r],
    edges: [edge(t, r)],
  });
}

// --- 10. Manual-output chain -------------------------------------------------
{
  resetIds();
  const idc = makeId;
  const m = manualTrigger(idc, { label: "Manual Trigger", manualOutput: true, manualOutputJson: '{\n  "name": "Ada"\n}' });
  const s = setNode(idc, { fields: [{ key: "greeting", value: "Hello {{name}}" }] });
  const c1 = codeNode(idc, { label: "Uppercase", code: "return items.map(it => ({ json: { ...it.json, greeting: String(it.json.greeting || '').toUpperCase() } }));" });
  const c2 = codeNode(idc, { label: "AddExclamation", code: "return items.map(it => ({ json: { ...it.json, greeting: it.json.greeting + '!' } }));" });
  W.push({
    id: uuid("wf-manual"),
    name: "Test 10 — Manual Chain + Stepping",
    description: "Manual trigger → set → code → code. Run normally, then use 'Run next node' to step past a halted node using manual output.",
    nodes: [m, s, c1, c2],
    edges: [edge(m, s), edge(s, c1), edge(c1, c2)],
  });
}

for (const w of W) {
  const file = path.join(OUT, `${w.id}.json`);
  fs.writeFileSync(file, JSON.stringify(w, null, 2));
  console.log("wrote", path.relative(__dirname, file));
}
console.log("\nDone —", W.length, "test workflows written to", path.relative(__dirname, OUT));