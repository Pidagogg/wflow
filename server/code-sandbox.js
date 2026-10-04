// ============================================================================
// W FLOW — sandboxed runner for the JavaScript nodes.
//
// The Code / JS Transform / JS Filter / JS Aggregate nodes run arbitrary user
// JavaScript. Running it in the server process let any signed-in account reach
// process.env (the encryption key, DATABASE_URL, Stripe/SMTP secrets), the
// filesystem (every account's data) and child_process — i.e. full host takeover
// on a shared instance. So the code now runs in a short-lived CHILD process
// locked down with Node's permission model: no filesystem, no child processes,
// no workers, and a scrubbed environment. Only `fetch` survives, because these
// nodes exist to call HTTP APIs. See server/code-worker.mjs for the child.
//
// One child is spawned per node execution (not per item): the worker does the
// iteration, so semantics are identical to the old in-process version. Spawning
// a process costs a few milliseconds — a fair price for not handing every user
// a shell on the server.
// ============================================================================
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "code-worker.mjs");

// How long a single node's code may run before it is killed (ms). Generous for
// a few HTTP calls, short enough that a `while(true)` cannot hang a run.
const CODE_TIMEOUT_MS = Math.max(1000, Number(process.env.BF_CODE_TIMEOUT_MS) || 30_000);
// Cap the request/response size so a huge item set cannot exhaust memory in the
// pipe. 32 MB each way.
const MAX_IO_BYTES = 32 * 1024 * 1024;

// The child starts with ONLY these environment variables. None are app secrets;
// they are the harmless OS vars `fetch`/DNS/TLS need to work. Everything in the
// server's process.env (BF_ENCRYPTION_KEY, DATABASE_URL, STRIPE_*, …) is left
// behind, so user code cannot read it.
function childEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "LANG", "TZ", "NODE_EXTRA_CA_CERTS"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * Run one JavaScript node's code in the sandbox.
 *
 * @param {"code"|"jsTransform"|"jsFilter"|"jsAggregate"} kind
 * @param {string} code  the user's code
 * @param {Array}  items the node's input items ([{ json }])
 * @returns {Promise<Array>} the output items the node produced
 * @throws  on a hard failure (Code / JS Transform) — message is the user error
 */
export function runSandboxedCode(kind, code, items) {
  const request = JSON.stringify({ kind, code: String(code || ""), items: items || [] });
  if (Buffer.byteLength(request) > MAX_IO_BYTES) {
    return Promise.reject(new Error("Too much data for the code node to process in one run."));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ["--permission", `--allow-fs-read=${WORKER}`, WORKER], {
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`Could not start the code sandbox: ${String(err?.message || err)}`));
      return;
    }

    let out = "";
    let errText = "";
    let overflow = false;
    let settled = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      fn(arg);
    };

    const timer = setTimeout(() => {
      done(reject, new Error(`The code node timed out after ${CODE_TIMEOUT_MS} ms.`));
    }, CODE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_IO_BYTES) {
        overflow = true;
        done(reject, new Error("The code node produced too much output."));
      }
    });
    child.stderr.on("data", (d) => {
      if (errText.length < 4000) errText += d;
    });
    child.on("error", (err) => done(reject, new Error(`Could not run the code sandbox: ${String(err?.message || err)}`)));
    child.on("close", (exitCode) => {
      if (overflow) return;
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        done(
          reject,
          new Error(
            exitCode === 13 || /not allowed|ERR_ACCESS_DENIED/i.test(errText)
              ? "The code node tried to do something the sandbox forbids (file, process or module access)."
              : `The code node did not return a result${errText ? `: ${errText.slice(0, 300)}` : "."}`
          )
        );
        return;
      }
      if (parsed && parsed.ok) done(resolve, parsed.out || []);
      else done(reject, new Error(String(parsed?.error || "The code node failed.")));
    });

    try {
      child.stdin.end(request);
    } catch (err) {
      done(reject, new Error(`Could not send input to the code sandbox: ${String(err?.message || err)}`));
    }
  });
}
