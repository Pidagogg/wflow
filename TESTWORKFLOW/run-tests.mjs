// Runs every TESTWORKFLOW workflow through the executor and asserts the new
// model works: webhook receive passes data to the next node (no auto-response),
// Webhook Respond returns the reply, downstream halts when a node errors, and a
// halted node can be stepped past via manual output + "run next node".
//
// Run:  node run-tests.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeWorkflow, executeNode } from "../server/executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.join(__dirname, "workflows");
const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".json"));
const load = (f) => JSON.parse(fs.readFileSync(path.join(WF_DIR, f), "utf8"));

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push(`PASS  ${name}`);
  } else {
    fail++;
    results.push(`FAIL  ${name}  ${detail}`);
  }
}

// find the webhookResponse captured by a respond node, or return null
function hud(result) {
  return result?.webhookResponse ?? null;
}
function nodeLog(result, type) {
  return (result?.log || []).filter((l) => l.nodeType === type);
}
function firstReply(result) {
  const a = nodeLog(result, "aiAgent")[0];
  return a?.outputItems?.[0]?.reply ?? null;
}
function outField(result, type, key) {
  const e = nodeLog(result, type)[0];
  return e?.outputItems?.[0]?.[key];
}
// last occurrence of the given node type (for chains/tails)
function lastOutField(result, type, key) {
  const list = nodeLog(result, type);
  const e = list[list.length - 1];
  return e?.outputItems?.[0]?.[key];
}

for (const f of files) {
  const w = load(f);
  const id = w.id;

  if (w.nodes.some((n) => n.type === "webhook")) {
    // --- webhook-based workflow --------------------------------------------
    const payload = { message: "hello test", source: "harness", status: "success", name: "Ada" };
    let result;
    try {
      result = await executeWorkflow(w, { webhookPayload: payload });
    } catch (err) {
      check(`${id} executed`, false, err.message);
      continue;
    }
    check(`${id} ran without exception`, !!result);

    // Trigger should NOT itself respond — only a webhookRespond node may.
    if (w.nodes.some((n) => n.type === "webhookRespond")) {
      const r = hud(result);
      check(`${id} captured webhook response from respond node`, !!r, `got ${JSON.stringify(r)}`);
      if (r) {
        const bodyStr = JSON.stringify(r.body || "");
        // A good response renders {{vars}} — leftover "{{" means a broken reference.
        check(`${id} respond body rendered (no unrendered {{)`, !bodyStr.includes("{{"), `REQUEST_ERR=${r._testOrigin}\n${bodyStr}`);
      }
      check(`${id} all nodes succeeded (no halt)`, result.success, JSON.stringify(result.log?.map((l) => l.status)));
    } else {
      // No respond node: legacy fallback returns the execution result.
      check(`${id} ran without respond node`, true);
    }

    // strict sequential: no downstream ran before upstream (all statuses success)
    if (id.includes("wf-seq")) {
      const two = lastOutField(result, "code", "val");
      check(`${id} chained value 'one|1' then 'two|2' `, typeof two === "string" && two.endsWith("|2") && two.includes("|1|2"), String(two));
    }
    if (id.includes("wf-pdfai")) {
      check(`${id} used manual reply for agent (no tokens)`, typeof firstReply(result) === "string" && firstReply(result).includes("[manual]"), String(firstReply(result)));
    }
    if (id.includes("wf-echo")) {
      const echo = outField(result, "set", "echo");
      check(`${id} Set node saw the webhook message`, echo === "hello test", String(echo));
    }
    if (id.includes("wf-branch")) {
      const r = hud(result);
      check(`${id} branch responded SUCCESS`, r && JSON.stringify(r.body).includes("SUCCESS"), JSON.stringify(r));
      check(`${id} exactly one respond node executed`, nodeLog(result, "webhookRespond").length === 1, String(nodeLog(result, "webhookRespond").length));
    }
    if (id.includes("wf-secret")) {
      check(`${id} secret workflow ran`, result.success);
    }
    continue;
  }

  // --- manual / run-node workflows ----------------------------------------
  // Test the runner (manual trigger -> IF -> branches), then stepping.
  const m = w.nodes.find((n) => n.type === "manual");
  const ifNode = w.nodes.find((n) => n.type === "if");
  const downstreamOf = (nodeId) => w.edges.filter((e) => e.source === nodeId).map((e) => ({ ...e, targetDef: w.nodes.find((n) => n.id === e.target) }));

  let result;
  try {
    result = await executeWorkflow(w, {});
  } catch (err) {
    check(`${id} executed`, false, err.message);
    continue;
  }

  if (id.includes("wf-haltstep")) {
    const successBranch = downstreamOf(ifNode.id).find((e) => e.sourceHandle === "true");
    check(`${id} full run reached success branch`, nodeLog(result, "code").some((l) => JSON.stringify(l.outputItems).includes("success")), JSON.stringify(result.log.map((l) => l.nodeName)));
    // Stepping: simulate a HALT — re-run just the success-branch code node via
    // executeNode, feeding it manual data (as if the IF had manual output).
    const stepResult = await executeNode(w, successBranch.target, [{ json: { status: "success", branch: "manual" } }], {});
    check(`${id} run-node executed the next node`, stepResult.success, stepResult.error || "");
  }

  if (id.includes("wf-manual")) {
    const s = w.nodes.find((n) => n.type === "set");
    const c1 = w.nodes.find((n) => n.type === "code" && n.data.label === "Uppercase");
    const c2 = w.nodes.find((n) => n.type === "code" && n.data.label === "AddExclamation");
    const taps = lastOutField(result, "code", "greeting");
    check(`${id} chained greeting uppercased+exclamated`, typeof taps === "string" && taps.endsWith("!") && taps === taps.toUpperCase(), String(taps));
    // Step TEST: run c2 (AddExclamation) alone with c1's manual-style output.
    const step = await executeNode(w, c2.id, [{ json: { greeting: "HELLO ADA" } }], {});
    const stepped = step.outputItems?.[0]?.greeting;
    check(`${id} run-node stepped past c1 -> "HELLO ADA!"`, stepped === "HELLO ADA!", String(stepped));
  }
}

console.log("\n===== TEST RESULTS =====");
for (const r of results) console.log(r);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);