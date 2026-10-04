// ============================================================================
// W FLOW — restart helper for the one-click update (server/updater.js)
//
//   node server/update-restart.js <pid of the old server>
//
// Started detached by the old server right before it exits. It waits for that
// process to be gone, starts the new version (output goes to
// .wflow-update/server.log) and checks it answers on its port. If it does not
// within RESTART_TIMEOUT_MS, the new version is stopped, the backed-up app files
// are put back, dependencies are reinstalled for them and the old version is
// started instead — so a broken update never leaves the copy down.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".wflow-update");
const PORT = Number(process.env.WFLOW_UPDATE_PORT || process.env.PORT || 3001);
const RESTART_TIMEOUT_MS = Number(process.env.WFLOW_RESTART_TIMEOUT_MS) || 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  try {
    fs.mkdirSync(WORK, { recursive: true });
    fs.appendFileSync(path.join(WORK, "update.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* nowhere to write — carry on */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startServer() {
  const out = fs.openSync(path.join(WORK, "server.log"), "a");
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function answers() {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/config`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function main() {
  const oldPid = Number(process.argv[2]) || 0;
  for (let i = 0; i < 60 && oldPid && alive(oldPid); i++) await sleep(500);
  await sleep(500); // let the OS release the port
  log(`starting the new version on port ${PORT}`);
  const child = startServer();
  if (await answers()) {
    log("the new version is up");
    return;
  }
  log("the new version did not answer — rolling back");
  try {
    process.kill(child.pid);
  } catch {
    /* already gone */
  }
  await sleep(1000);
  const updater = await import("./updater.js");
  updater.restorePrevious(ROOT);
  try {
    await updater.installDependencies(ROOT);
  } catch (err) {
    log(`reinstalling the previous dependencies failed: ${err.message}`);
  }
  const statePath = path.join(WORK, "state.json");
  try {
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...st, phase: "failed", message: "", error: "The new version did not start, so the previous one was put back. See .wflow-update/server.log.", at: Date.now() }, null, 2)
    );
  } catch {
    /* no state to update */
  }
  startServer();
  log("the previous version was started again");
}

main().catch((err) => log(`restart helper failed: ${err.stack || err}`));
