// ============================================================================
// Only the official cloud runs without a licence key. Any other installation —
// a clone of the public repository started with `npm start`, a wrong cloud
// secret, WFLOW_STANDALONE=0 — is a self-hosted copy and needs a Pro licence
// (server/setup.js officialCloud, server/license.js licenseRequired).
//
// Run: node --test tests/official-cloud.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (rel) => pathToFileURL(path.join(root, rel)).href;
// Started from an empty folder: the server loads .env from where it starts, and
// the developer's own .env may hold the real cloud secret.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-cloud-"));

// A fresh process, like a real installation: no NODE_TEST_CONTEXT.
function modeWith(env) {
  const clean = { ...process.env };
  delete clean.NODE_TEST_CONTEXT;
  delete clean.WFLOW_CLOUD_SECRET;
  delete clean.WFLOW_STANDALONE;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const s = await import("${url("server/setup.js")}"); const l = await import("${url("server/license.js")}"); console.log(JSON.stringify({ cloud: s.officialCloud(), copy: s.standaloneMode(), licence: l.licenseRequired() }));`],
    { cwd: emptyDir, env: { ...clean, BF_ENV_PATH: path.join(emptyDir, ".env"), BF_DB_PATH: path.join(emptyDir, "t.db"), BF_DATA_DIR: emptyDir, ...env }, encoding: "utf8" }
  );
  return JSON.parse(out.trim().split("\n").pop());
}

test("a plain installation is a copy that needs a licence", () => {
  assert.deepEqual(modeWith({}), { cloud: false, copy: true, licence: true });
});

test("switching standalone off or guessing a secret does not make it the cloud", () => {
  assert.deepEqual(modeWith({ WFLOW_STANDALONE: "0" }), { cloud: false, copy: true, licence: true });
  assert.deepEqual(modeWith({ WFLOW_CLOUD_SECRET: "guess" }), { cloud: false, copy: true, licence: true });
});

test("the test suite runs as the cloud unless a test asks for a copy", () => {
  assert.deepEqual(modeWith({ NODE_TEST_CONTEXT: "child" }), { cloud: true, copy: false, licence: false });
  assert.deepEqual(modeWith({ NODE_TEST_CONTEXT: "child", WFLOW_STANDALONE: "1" }), { cloud: true, copy: true, licence: true });
});
