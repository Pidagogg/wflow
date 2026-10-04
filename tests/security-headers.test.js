// ============================================================================
// Main server — security & SEO response behavior over real HTTP.
// Spawns server/index.js on a random port with an isolated temp data dir and
// checks the hardening guarantees:
//   - /api and /webhook responses carry Cache-Control: no-store (GET
//     /api/workflows/:id returns decrypted credentials — a cache must never
//     hold onto them), while static/HTML responses are unaffected.
//   - a malformed JSON body gets a clean JSON 400 from the error middleware,
//     never Express's default HTML error page.
//   - the landing page + SEO files serve the YOUR-DOMAIN placeholder until a
//     site domain is configured (BF_SITE_DOMAIN here; the admin panel setting
//     takes precedence in production), and swap it for the real domain when
//     one is set.
//   - the SEO & GEO surfaces: the managed meta tags are injected into the
//     public pages, robots.txt carries the AI-crawler policy and /llms.txt is
//     generated — all of it switchable from the admin panel.
//
// Run: node --test tests/security-headers.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-http-test-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Boot server/index.js against an isolated data dir; resolves once it answers. */
async function spawnServer(extraEnv = {}, sub = "main") {
  const port = await freePort();
  const dir = path.join(tempDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(dir, "http.db"),
      BF_DATA_DIR: dir,
      BF_ENCRYPTION_KEY: "a".repeat(64),
      DATABASE_URL: "",
      DISABLE_SCHEDULER: "1",
      // The spawned server calls server/env.js, which re-applies the repo's
      // .env to process.env. Force BF_SITE_DOMAIN (and the admin env vars) so a
      // developer's local .env cannot leak in and change what the suite asserts
      // (extraEnv below may still override these).
      BF_SITE_DOMAIN: "",
      BF_ADMIN_USERNAME: "test-admin",
      BF_ADMIN_PASSWORD: "test-admin-pass-123",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logTail = "";
  child.stdout.on("data", (d) => (logTail += d.toString()));
  child.stderr.on("data", (d) => (logTail += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logTail}`);
    }
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start in time:\n${logTail}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    base,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      // SQLite may hold the file briefly after the child exits (Windows)
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}

let srv;

before(async () => {
  srv = await spawnServer({}, "main");
});

after(async () => {
  if (srv) await srv.stop();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("API responses are never cached (Cache-Control: no-store)", async () => {
  const res = await fetch(`${srv.base}/api/auth/config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("static/HTML responses are not forced no-store", async () => {
  // dist/ exists after a build — the SPA fallback serves index.html
  const res = await fetch(`${srv.base}/`);
  assert.ok(res.ok, "the SPA index is served");
  assert.notEqual(res.headers.get("cache-control"), "no-store");
});

test("malformed JSON gets a clean JSON 400 (no HTML error page)", async () => {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"email": "oops',
  });
  assert.equal(res.status, 400);
  const type = res.headers.get("content-type") || "";
  assert.match(type, /application\/json/, "the error response is JSON, not HTML");
  const body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("unknown API paths keep returning JSON 404s", async () => {
  const res = await fetch(`${srv.base}/api/definitely-not-a-route`);
  assert.equal(res.status, 404);
  const type = res.headers.get("content-type") || "";
  assert.match(type, /application\/json/, "API 404s are JSON");
});

test("SEO files keep the YOUR-DOMAIN placeholder until a site domain is set", async () => {
  for (const p of ["/landing.html", "/robots.txt", "/sitemap.xml"]) {
    const res = await fetch(`${srv.base}${p}`);
    assert.equal(res.status, 200, `${p} is served`);
    const text = await res.text();
    assert.ok(text.includes("YOUR-DOMAIN"), `${p} still carries the placeholder`);
  }
});

test("a configured site domain replaces YOUR-DOMAIN in the SEO files", async () => {
  const seo = await spawnServer({ BF_SITE_DOMAIN: "flow.example.com" }, "seo");
  try {
    const [landing, robots, sitemap] = await Promise.all([
      fetch(`${seo.base}/landing.html`).then((r) => r.text()),
      fetch(`${seo.base}/robots.txt`).then((r) => r.text()),
      fetch(`${seo.base}/sitemap.xml`).then((r) => r.text()),
    ]);
    assert.ok(!landing.includes("YOUR-DOMAIN"), "landing has no leftover placeholder");
    assert.ok(landing.includes('href="https://flow.example.com/landing.html"'), "canonical uses the real domain");
    assert.ok(landing.includes('property="og:url" content="https://flow.example.com/landing.html"'), "og:url is substituted");
    assert.ok(landing.includes('content="https://flow.example.com/og-image.png"'), "og:image is substituted (the 1200×630 share card)");
    assert.ok(!robots.includes("YOUR-DOMAIN"), "robots has no leftover placeholder");
    assert.ok(robots.includes("Sitemap: https://flow.example.com/sitemap.xml"), "robots points at the real sitemap");
    assert.ok(!sitemap.includes("YOUR-DOMAIN"), "sitemap has no leftover placeholder");
    assert.ok(sitemap.includes("<loc>https://flow.example.com/landing.html</loc>"), "sitemap URLs use the real domain");
  } finally {
    await seo.stop();
  }
});

test("GEO surfaces: /llms.txt and the AI crawler policy in robots.txt", async () => {
  const llms = await fetch(`${srv.base}/llms.txt`);
  assert.equal(llms.status, 200, "llms.txt is published by default");
  const llmsText = await llms.text();
  assert.match(llmsText, /^# /m, "llms.txt starts with a title");
  assert.match(llmsText, /## Key facts/);

  const robots = await (await fetch(`${srv.base}/robots.txt`)).text();
  assert.match(robots, /User-agent: GPTBot/);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /User-agent: PerplexityBot/);
  assert.match(robots, /Allow: \//);
});

test("the operator can switch AI crawlers and llms.txt off", async () => {
  const off = await spawnServer({ BF_GEO_AI_CRAWLERS: "0", BF_GEO_LLMS: "0" }, "geo-off");
  try {
    const llms = await fetch(`${off.base}/llms.txt`);
    assert.equal(llms.status, 404, "llms.txt is switched off");
    const robots = await (await fetch(`${off.base}/robots.txt`)).text();
    assert.match(robots, /User-agent: GPTBot[\s\S]*?Disallow: \//, "AI crawlers are disallowed");
  } finally {
    await off.stop();
  }
});

test("managed SEO meta tags are injected into the landing page", async () => {
  const meta = await spawnServer(
    { BF_SITE_DOMAIN: "flow.example.com", BF_SEO_TITLE: "Acme Flows", BF_SEO_DESCRIPTION: "Automate everything." },
    "seo-meta"
  );
  try {
    const landing = await (await fetch(`${meta.base}/landing.html`)).text();
    assert.match(landing, /<title>Acme Flows<\/title>/, "the operator's title wins");
    assert.match(landing, /content="Automate everything\."/, "the operator's description wins");
    assert.match(landing, /rel="canonical" href="https:\/\/flow\.example\.com\/landing\.html"/, "canonical uses the real domain");
    // exactly one <title> element survives the replacement
    assert.equal((landing.match(/<title>/g) || []).length, 1);
  } finally {
    await meta.stop();
  }
});
