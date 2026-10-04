// ----------------------------------------------------------------------------
// W FLOW — background scheduler
// Two jobs run from the same 30 s tick:
//
// 1. Cron — scans every saved workflow for Schedule (cron) trigger nodes and
//    executes the workflow in the background when the cron expression fires —
//    no manual "Run" needed. Credentials are hydrated from the encrypted
//    workflow_secrets table exactly like a normal run, and each workflow runs
//    as its owner.
//
// 2. RSS — polls every saved workflow that has an RSS trigger node and runs
//    the workflow when NEW items appear in the feed. The first poll after a
//    start/restart only records the current feed head (baseline), so old
//    items never fire; afterwards only items that appear after the last seen
//    head trigger a run.
//
// 3. Crypto — polls price, Polymarket and wallet-deposit triggers and runs the
//    workflow when their event happens (server/crypto-triggers.js).
//
// 4. Apps — polls the e-mail (IMAP, Gmail) and Google Sheets "new row"
//    triggers and runs the workflow for what arrived (server/app-triggers.js).
//
// Every fire type is subject to the same free-plan daily run cap as editor
// Run clicks and webhook calls (see quota.js): a fire consumes one of the
// owner's daily runs, and when the cap is exhausted the occurrence is skipped.
//
// Timing: a tick every 30 s checks whether each cron's next occurrence or RSS
// poll time has arrived. Cron occurrences fire once and advance to the
// following occurrence; RSS polls advance even when the fetch fails, so a
// broken feed never retries in a tight loop.
//
// Disable with DISABLE_SCHEDULER=1 (see .env.example).

// ----------------------------------------------------------------------------
import cronParser from "cron-parser";
import { workflows, hydrateSecretsInWorkflow } from "./store.js";
import { db } from "./dbx.js";
import { runQuota, isProUser } from "./quota.js";
// Runs are routed: locally, or to the remote runner set up in Setup.
import { executeRouted } from "./runner.js";
import { recordExecution } from "./executions.js";
import { parseRssFeed } from "./fileextract.js";
import { cryptoTriggerNodes, pollCryptoTrigger, resetCryptoTriggerState } from "./crypto-triggers.js";
import { appTriggerNodes, pollAppTrigger, resetAppTriggerState } from "./app-triggers.js";
import { assertPublicHttpUrl, withConnectedAccount } from "./executor.js";
import { startLoop, isLoopRunning, loopFinished, stopAllLoops } from "./loop-runner.js";

// Why a fire was skipped, for the server log.
function quotaReason(quota) {
  return quota.reason === "license"
    ? "this self-hosted copy has no active licence"
    : `free-plan owner used all ${quota.limit} daily runs (Pro lifts the cap)`;
}

const TICK_MS = 30000;

// Map "workflowId::nodeId" → Date of the next cron occurrence to fire. Each
// occurrence fires exactly once: after firing we advance to the occurrence
// that follows it. On restart the map is empty, so the next fire is computed
// from "now" — missed occurrences are not backfilled.
const nextFires = new Map();

// Map "workflowId::nodeId" → epoch ms of the next RSS poll.
const nextPolls = new Map();

// Map "workflowId::nodeId" → { k, t } of the newest item the last poll saw
// (k = guid/link fingerprint, t = parsed pubDate). Only items newer than this
// trigger a run.
const lastSeen = new Map();

// Background loops whose owner is no longer Pro — logged once, not every tick.
const pausedLoops = new Set();

function scheduleNodes(wf) {
  return (wf.nodes || []).filter((n) => n.type === "schedule");
}

function rssTriggerNodes(wf) {
  return (wf.nodes || []).filter((n) => n.type === "rssTrigger");
}

function rssPollIntervalMs(c) {
  const minutes = Number(c.pollInterval) > 0 ? Number(c.pollInterval) : 5;
  return Math.max(30_000, minutes * 60_000);
}

function rssItemKey(it) {
  const guidOrLink = String(it?.guid || it?.link || "").trim();
  return guidOrLink || `${it?.title || ""}|${it?.pubDate || ""}`;
}

function rssItemTime(it) {
  const t = Date.parse(String(it?.pubDate || ""));
  return Number.isFinite(t) ? t : 0;
}

function parseNext(cron, tz, from) {
  return cronParser.parseExpression(cron, { tz: tz || undefined, currentDate: from || undefined }).next().toDate();
}

// Fetch a feed and parse it into { feedTitle, items } (same parser as the RSS
// Read action node). A failed fetch throws — callers log and move on.
async function fetchRss(url) {
  const res = await fetch(String(url), { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  const xml = await res.text().catch(() => "");
  return parseRssFeed(xml, 50);
}

// Record what the feed's newest item looks like, so the NEXT poll knows what
// "already seen" means.
function rememberRssHead(key, feed) {
  const head = feed.items[0];
  lastSeen.set(key, head ? { k: rssItemKey(head), t: rssItemTime(head) } : { k: "", t: 0 });
}

async function runScheduled(stored, node, fireTime) {
  // Free-plan daily-run cap: a cron fire counts as one of the owner's daily
  // runs, exactly like an editor Run or a webhook call. Pro owners are
  // unlimited; a free owner at the cap has this occurrence skipped (and the
  // schedule still advances in tick(), so it never retries the same fire).
  const quota = await runQuota(stored.ownerId);
  if (!quota.allowed) {
    console.log(
      `  [scheduler] skipped "${stored.name}" (${fireTime.toISOString()}) — ${quotaReason(quota)}`
    );
    return;
  }
  const wf = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
  const c = node.data?.config || {};
  const payload = {
    triggeredAt: fireTime.toISOString(),
    cron: c.cron || "",
    timezone: c.timezone || "UTC",
  };
  // consume the run before executing (mirrors the editor/webhook paths); 0
  // disables the cap, in which case quota.limit is null and nothing is counted
  if (quota.limit !== null) await db.bumpRunUsage(stored.ownerId);
  const result = await executeRouted(wf, {
    source: "schedule", // listed as running until recordExecution saves it
    triggerPayload: payload,
    maxItemsPerNode: 5,
    userId: stored.ownerId,
  });
  await recordExecution(stored, result, "schedule");
  const failed = (result.log || []).filter((l) => l.status === "error").length;
  console.log(
    `  [scheduler] ran "${stored.name}" (${fireTime.toISOString()}) — ${failed ? `${failed} node(s) failed` : "all nodes OK"} (${result.durationMs} ms)`
  );
}

// Fire a workflow because its RSS feed gained new items. The new items are
// passed to the rssTrigger node via triggerPayload, which turns them into the
// run's input (same shape as the sample payload, so downstream logic is
// identical between manual runs and live fires).
async function runRssFired(stored, url, feedTitle, items, now) {
  const quota = await runQuota(stored.ownerId);
  if (!quota.allowed) {
    console.log(
      `  [scheduler] rss skipped "${stored.name}" (${new Date(now).toISOString()}) — ${quotaReason(quota)}`
    );
    return;
  }
  const wf = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
  if (quota.limit !== null) await db.bumpRunUsage(stored.ownerId);
  const payload = {
    feed: url,
    feedTitle: feedTitle || "",
    polledAt: new Date(now).toISOString(),
    items,
    count: items.length,
  };
  const result = await executeRouted(wf, {
    source: "schedule", // listed as running until recordExecution saves it
    triggerPayload: payload,
    maxItemsPerNode: 5,
    userId: stored.ownerId,
  });
  await recordExecution(stored, result, "schedule");
  const failed = (result.log || []).filter((l) => l.status === "error").length;
  console.log(
    `  [scheduler] rss ran "${stored.name}" (${new Date(now).toISOString()}) — ${items.length} new item(s), ${failed ? `${failed} node(s) failed` : "all nodes OK"} (${result.durationMs} ms)`
  );
}

// Fire a workflow because a polled trigger's event happened (price crossed a
// level, a deposit arrived, new mail or rows). Same quota rules as every other
// fire.
async function runPolledFired(stored, node, payload, now) {
  const quota = await runQuota(stored.ownerId);
  if (!quota.allowed) {
    console.log(`  [scheduler] ${node.type} skipped "${stored.name}" — ${quotaReason(quota)}`);
    return;
  }
  const wf = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
  if (quota.limit !== null) await db.bumpRunUsage(stored.ownerId);
  const result = await executeRouted(wf, {
    source: "schedule", // listed as running until recordExecution saves it
    triggerPayload: payload,
    runInput: payload,
    maxItemsPerNode: 5,
    userId: stored.ownerId,
  });
  await recordExecution(stored, result, "schedule");
  const failed = (result.log || []).filter((l) => l.status === "error").length;
  console.log(
    `  [scheduler] ${node.type} ran "${stored.name}" (${new Date(now).toISOString()}) — ${failed ? `${failed} node(s) failed` : "all nodes OK"} (${result.durationMs} ms)`
  );
}

// One RSS poll: fetch the feed, compare against the last seen head and fire
// the workflow for anything genuinely new. The feed head is committed BEFORE
// firing so a crashed workflow never replays the same items.
async function pollRssTrigger(stored, node, url, key, now) {
  const feed = await fetchRss(url);
  const prev = lastSeen.get(key);
  if (!prev) {
    rememberRssHead(key, feed);
    return;
  }
  const head = feed.items[0];
  const newItems = [];
  if (head && rssItemKey(head) !== prev.k) {
    for (const it of feed.items) {
      if (rssItemKey(it) === prev.k) break;
      newItems.push(it);
      if (newItems.length >= 50) break;
    }
    if (newItems.length === 0) {
      // The previous head has already fallen out of the feed (rotated): only
      // fire the new head, and only when it is genuinely newer, to avoid a
      // flood of stale entries.
      if (rssItemTime(head) > prev.t) newItems.push(head);
    }
  }
  rememberRssHead(key, feed);
  if (newItems.length) {
    await runRssFired(stored, url, feed.feedTitle, newItems, now);
  }
}

// Run one scheduler pass at the given time (defaults to "now", injectable for
// tests). Fires every cron whose next occurrence has arrived and every RSS
// poll that is due, each exactly once.
async function tick(now = Date.now()) {
  for (const stored of await workflows.all()) {
    // --- cron triggers ------------------------------------------------------
    for (const node of scheduleNodes(stored)) {
      const c = node.data?.config || {};
      const cron = String(c.cron || "").trim();
      if (!cron) continue;
      const key = `${stored.id}::${node.id}`;
      let nextTime = nextFires.get(key);
      if (!nextTime) {
        try {
          // currentDate = the tick clock (defaults to real now in production;
          // injectable via the `now` argument so tests are deterministic)
          nextTime = parseNext(cron, c.timezone, new Date(now));
        } catch {
          continue; // invalid cron expression — skip
        }
        nextFires.set(key, nextTime);
      }
      if (now < nextTime.getTime()) continue;
      try {
        await runScheduled(stored, node, nextTime);
      } catch (err) {
        console.error(`  [scheduler] workflow "${stored.name}" (${stored.id}) failed: ${String(err.message || err)}`);
      }
      // advance to the occurrence that follows the one we just fired
      try {
        nextTime = parseNext(cron, c.timezone, nextTime);
      } catch {
        nextFires.delete(key);
        continue;
      }
      nextFires.set(key, nextTime);
    }

    // --- rss triggers -------------------------------------------------------
    for (const node of rssTriggerNodes(stored)) {
      const c = node.data?.config || {};
      const url = String(c.url || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const key = `${stored.id}::${node.id}`;
      const interval = rssPollIntervalMs(c);
      const nextPoll = nextPolls.get(key);
      if (nextPoll === undefined) {
        // First sight (startup / deploy / after a reset): poll once to record
        // the current feed head as the baseline so pre-existing items never
        // fire, then start the interval clock.
        try {
          const feed = await fetchRss(url);
          rememberRssHead(key, feed);
        } catch (err) {
          console.error(`  [scheduler] rss "${stored.name}" (${stored.id}) initial poll failed: ${String(err?.message || err).slice(0, 160)}`);
        }
        nextPolls.set(key, now + interval);
        continue;
      }
      if (now < nextPoll) continue;
      // Advance the clock first: a poll that fails (network, quota-skipped
      // fire) is never retried in a tight loop.
      nextPolls.set(key, now + interval);
      try {
        await pollRssTrigger(stored, node, url, key, now);
      } catch (err) {
        console.error(`  [scheduler] rss "${stored.name}" (${stored.id}) poll failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }

    // --- crypto triggers ----------------------------------------------------
    for (const node of cryptoTriggerNodes(stored)) {
      try {
        await pollCryptoTrigger(stored, node, now, (payload) => runPolledFired(stored, node, payload, now), { assertUrl: assertPublicHttpUrl });
      } catch (err) {
        console.error(`  [scheduler] ${node.type} "${stored.name}" (${stored.id}) poll failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }

    // --- app triggers (e-mail, Google Sheets) -------------------------------
    for (const node of appTriggerNodes(stored)) {
      try {
        await pollAppTrigger(stored, node, now, (payload) => runPolledFired(stored, node, payload, now), {
          assertUrl: assertPublicHttpUrl,
          // the stored workflow has its secrets stripped: fill in the app
          // password / API key and a connected Google account only when due
          loadConfig: async () => {
            const wf = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
            const full = (wf.nodes || []).find((n) => n.id === node.id) || node;
            return (await withConnectedAccount(full, { userId: stored.ownerId })).data?.config || {};
          },
        });
      } catch (err) {
        console.error(`  [scheduler] ${node.type} "${stored.name}" (${stored.id}) poll failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }

    // --- background loops (Pro) --------------------------------------------
    // A workflow switched to background execution with its repeat setting on
    // keeps running while its owner is offline. The loop runner owns the
    // timing (one timer per loop, so a 10 s interval really is 10 s, not the
    // next 30 s tick); the scheduler only starts loops that are not running
    // yet and have not already finished with their current setting.
    if (stored.executionMode === "background" && stored.loop?.enabled && !isLoopRunning(stored.id) && !loopFinished(stored)) {
      if (await isProUser(stored.ownerId)) {
        startLoop(stored, { immediate: true });
      } else if (!pausedLoops.has(stored.id)) {
        pausedLoops.add(stored.id);
        console.log(`  [scheduler] background loop "${stored.name}" paused — background execution is a Pro feature`);
      }
    }
  }
}

export async function startScheduler() {
  if (String(process.env.DISABLE_SCHEDULER || "").trim() === "1") {
    console.log("  [scheduler] disabled (DISABLE_SCHEDULER=1)");
    return () => {};
  }
  // A tick that outlasts the interval (slow feeds, long workflows) must not
  // start a second one on top of it — that doubles the work exactly when the
  // server is already busy. The next interval simply picks up.
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.error(`  [scheduler] tick error: ${String(err.message || err)}`))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  // don't keep the process alive just for the scheduler
  timer.unref?.();
  console.log(`  [scheduler] watching ${(await workflows.all()).length} workflow(s) for cron, rss, crypto, e-mail and Sheets triggers and Pro background loops (tick every ${TICK_MS / 1000} s)`);
  return () => clearInterval(timer);
}

// Export the tick loop + a state reset so tests can drive the scheduler
// deterministically (inject a fake clock via the `now` argument).
export { tick };
export function resetSchedulerState() {
  nextFires.clear();
  nextPolls.clear();
  lastSeen.clear();
  pausedLoops.clear();
  stopAllLoops();
  resetCryptoTriggerState();
  resetAppTriggerState();
}
