// ============================================================================
// Search-engine surface of the home page and the beta-test switch.
//
// The home page must carry readable text and schema.org data in the HTML
// itself (the React bundle only fills it in later), www must redirect page
// loads to the canonical host without breaking API calls, and the beta banner
// flag must reach the UI through the public config.
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { structuredData, crawlableIntro } from "../server/seo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-seo-"));
const hasDist = fs.existsSync(path.join(repoRoot, "dist", "index.html"));

test("structured data cannot be broken out of its script tag", () => {
  const html = structuredData({ domain: "example.com", siteName: "</script><b>x", description: "d" });
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(JSON.parse(html.replace(/^<script[^>]*>|<\/script>$/g, "")));
});

test("the static intro escapes operator text and has one h1", () => {
  const html = crawlableIntro({ siteName: "W", tagline: "<img src=x>", description: "a & b" });
  assert.ok(!html.includes("<img"));
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /a &amp; b/);
});

let child;
let base = "";

before(async () => {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(tempDir, "seo.db"),
      BF_DATA_DIR: path.join(tempDir, "data"),
      BF_SITE_DOMAIN: "w-flow.example",
      DISABLE_SCHEDULER: "1",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/auth/config`)).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
});

after(() => child?.kill());

test("the beta banner is on by default", async () => {
  const cfg = await (await fetch(`${base}/api/auth/config`)).json();
  assert.equal(cfg.betaBanner, true);
});

// fetch() will not send a custom Host header, so this goes through node:http
function getWithHost(pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${pathname}`, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location || "" });
    });
    req.on("error", reject);
  });
}

test("www page loads redirect to the canonical host; API calls do not", async () => {
  const page = await getWithHost("/datenschutz?lang=de", "www.w-flow.example");
  assert.equal(page.status, 301);
  assert.equal(page.location, "https://w-flow.example/datenschutz?lang=de");
  const apiCall = await getWithHost("/api/auth/config", "www.w-flow.example");
  assert.equal(apiCall.status, 200);
});

test("the home page ships readable text and schema.org data", { skip: !hasDist && "needs npm run build" }, async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<div id="root"><main[^>]*>[\s\S]*<h1/);
  assert.match(html, /application\/ld\+json/);
  const other = await (await fetch(`${base}/home`)).text();
  assert.ok(!other.includes("application/ld+json"), "only the home page carries it");
});

test("guides are served in both languages and listed in the sitemap", { skip: !hasDist && "needs npm run build" }, async () => {
  const { GUIDES } = await import("../server/guides.js");
  for (const prefix of ["/guides", "/de/guides"]) {
    const index = await fetch(`${base}${prefix}`);
    assert.equal(index.status, 200, prefix);
    const html = await index.text();
    for (const g of GUIDES) assert.ok(html.includes(`${prefix}/${g.slug}`), `${prefix} links ${g.slug}`);
  }
  const page = await (await fetch(`${base}/de/guides/${GUIDES[0].slug}`)).text();
  assert.match(page, /<html lang="de">/);
  assert.match(page, new RegExp(`rel="canonical" href="https://w-flow\.example/de/guides/${GUIDES[0].slug}"`));
  assert.match(page, /hreflang="en"/);
  assert.equal((await fetch(`${base}/guides/no-such-guide`)).status, 200, "unknown slugs fall through to the app shell");
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.ok(sitemap.includes(`https://w-flow.example/guides/${GUIDES[0].slug}`));
  assert.ok(sitemap.includes(`https://w-flow.example/de/guides/${GUIDES[0].slug}`));
});

test("GEO: llms.txt lists the guides and FAQ, llms-full.txt carries their text", async () => {
  const { GUIDES } = await import("../server/guides.js");
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  assert.match(llms, /## Guides/);
  assert.ok(llms.includes(`https://w-flow.example/guides/${GUIDES[0].slug}`));
  assert.match(llms, /## FAQ/);
  assert.match(llms, /llms-full\.txt/);
  const full = await fetch(`${base}/llms-full.txt`);
  assert.equal(full.status, 200);
  const text = await full.text();
  assert.ok(text.includes(GUIDES[1].en.title));
  assert.ok(!/<(p|li|h2|strong)\b/.test(text), "guide HTML is converted to markdown");
});

test("SEO defaults: keywords, 1200×630 share image, robots keeps crawlers out of the API", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<meta name="keywords" content="[^"]*n8n alternative/);
  assert.match(html, /og:image" content="https:\/\/w-flow\.example\/og-image\.png"/);
  assert.match(html, /og:image:width" content="1200"/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/w-flow\.example\/sitemap\.xml$/m);
});

