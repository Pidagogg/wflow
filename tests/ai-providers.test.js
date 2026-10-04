// ============================================================================
// The AI provider catalog (shared/catalog.js → AI_PROVIDERS).
//
// These lists are what the model pickers suggest before (or without) an API key:
// the node inspector, the saved-agent editor and the AI builder's setup panel
// all fall back to them, so they have to be well-formed — a duplicated entry, a
// missing default model or a shortened list is a visible UI bug.
//
// Run: node --test tests/ai-providers.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";

const { AI_PROVIDERS } = await import("../shared/catalog.js");

// Every provider the app documents in the README / setup panels.
const EXPECTED = [
  "openai", "anthropic", "google", "openrouter", "mistral", "groq", "deepseek", "grok", "together",
  "perplexity", "cohere", "huggingface", "cerebras", "nvidia", "fireworks", "sambanova", "github",
  "voyage", "jina", "lmstudio", "ollama", "custom",
];

test("every documented provider is present, exactly once", () => {
  const values = AI_PROVIDERS.map((p) => p.value);
  assert.deepEqual([...values].sort(), [...EXPECTED].sort());
  assert.equal(new Set(values).size, values.length, "no duplicate provider values");
});

test("each provider is complete enough to render a picker", () => {
  for (const provider of AI_PROVIDERS) {
    assert.ok(provider.label && typeof provider.label === "string", `${provider.value} has a label`);
    assert.equal(typeof provider.defaultBaseUrl, "string", `${provider.value} has a base URL (empty for custom)`);
    assert.equal(typeof provider.defaultModel, "string", `${provider.value} has a default model`);
    if (provider.value !== "custom") {
      assert.ok(provider.defaultBaseUrl.startsWith("http"), `${provider.value} has a usable base URL`);
      assert.ok(provider.defaultModel, `${provider.value} names a default model`);
    }
  }
});

test("every provider offers model suggestions, and the default is one of them", () => {
  for (const provider of AI_PROVIDERS) {
    if (provider.value === "custom") {
      assert.deepEqual(provider.models, [], "a custom endpoint has no list to suggest");
      continue;
    }
    assert.ok(Array.isArray(provider.models) && provider.models.length >= 5, `${provider.value} suggests several models`);
    assert.ok(provider.models.includes(provider.defaultModel), `${provider.value} suggests its own default model`);
    for (const model of provider.models) {
      assert.equal(typeof model, "string", `${provider.value} model names are strings`);
      assert.equal(model.trim(), model, `${provider.value} model names have no stray whitespace`);
      assert.notEqual(model, "", `${provider.value} has no empty model name`);
      assert.equal(/\s/.test(model), false, `${provider.value} model name "${model}" has no spaces`);
    }
  }
});

test("no provider suggests the same model twice (case-insensitively)", () => {
  for (const provider of AI_PROVIDERS) {
    const lower = (provider.models || []).map((m) => m.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `${provider.value} has no duplicate model`);
  }
});

test("the catalog is a real suggestion set, not a token one", () => {
  const total = AI_PROVIDERS.reduce((n, p) => n + (p.models?.length || 0), 0);
  assert.ok(total >= 100, `the providers suggest at least 100 models between them (got ${total})`);
  // The big hosted providers are the ones users pick models from most often.
  for (const value of ["openai", "anthropic", "google", "openrouter"]) {
    const provider = AI_PROVIDERS.find((p) => p.value === value);
    assert.ok(provider.models.length >= 10, `${value} suggests at least 10 models (got ${provider.models.length})`);
  }
});
