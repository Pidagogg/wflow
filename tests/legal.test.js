// ============================================================================
// Legal pages (Impressum · Datenschutzerklärung) — the login-free document site
// served at root paths on the main site (/impressum, /datenschutz, plus the
// /legal/* alias) and on the legal subdomain (Host-header routing), in
// German / English / Russian. There is no AGB / terms page and no withdrawal
// notice — those URLs must return 404.
//
// Spawns the real server with BF_LEGAL_DOMAIN=info.example.test and a
// LEGAL_COMPANY env value, then drives it over HTTP — including raw requests
// with a custom Host header (undici's fetch forbids setting Host, so the
// subdomain routing is tested with node:http).
//
// Run: node --test tests/legal.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-legal-"));
const dbPath = path.join(tempDir, "legal.db");
const dataDir = path.join(tempDir, "data");

// the legal subdomain under test
const LEGAL_HOST = "info.example.test";
const COMPANY = "Acme Test GmbH";
const OPERATOR = "Max Mustermann";

// The sections the privacy policy must always carry, in this order.
const DATENSCHUTZ_SECTIONS = [
  "1. Verantwortlicher",
  "2. Hosting / VPS",
  "3. Cloudflare",
  "4. PostgreSQL / Datenbank",
  "5. Registrierung (Nutzerkonto)",
  "6. Login / Authentifizierung",
  "6a. Verbundene Konten (Google und andere Dienste)",
  "7. Bestätigungs-E-Mails",
  "8. IP-Adressen / Server-Logs",
  "9. Cookies / lokaler Speicher",
  "10. Löschung von Daten",
  "11. Speicherdauer",
  "12. Rechtsgrundlagen",
  "13. Rechte der Betroffenen",
  "14. Internationale Datenübermittlungen",
  "15. Aufsichtsbehörde / Beschwerderecht",
];

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child;
let base = "";
let port = 0;

// Raw request with a custom Host header (node:http — fetch forbids Host).
function getWithHost(host, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, setCookie: res.headers["set-cookie"] || [] }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      BF_LEGAL_DOMAIN: LEGAL_HOST,
      LEGAL_COMPANY: COMPANY,
      LEGAL_NAME: OPERATOR,
      // Datenschutz placeholders — the third-country / register / VAT fields stay
      // unset on purpose so the test can prove the optional lines disappear
      LEGAL_LOG_RETENTION: "7 Tage",
      LEGAL_HOSTER: "Hetzner Online GmbH",
      LEGAL_SESSION_TECH: "technisch notwendige Session-Cookies",
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("only Impressum and Datenschutz are served at root paths", async () => {
  // Impressum at root renders the operator details
  const impressum = await fetch(`${base}/impressum`);
  assert.equal(impressum.status, 200);
  assert.match(await impressum.text(), /Acme Test GmbH/);

  // Datenschutz at root
  const ds = await fetch(`${base}/datenschutz`);
  assert.equal(ds.status, 200);
  assert.match(await ds.text(), /Datenschutzerklärung/);

  // English aliases still work too
  const privacy = await fetch(`${base}/privacy?lang=en`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Privacy Policy/);

  // There is no terms/AGB page and no withdrawal notice any more.
  for (const gone of ["/agb", "/terms", "/widerruf", "/withdrawal"]) {
    const res = await fetch(`${base}${gone}`);
    assert.equal(res.status, 404, `${gone} must not exist`);
  }
});

test("the privacy policy always carries the 15 required sections", async () => {
  const html = await (await fetch(`${base}/datenschutz`)).text();
  let lastIndex = -1;
  for (const heading of DATENSCHUTZ_SECTIONS) {
    const at = html.indexOf(`<h2>${heading}</h2>`);
    assert.ok(at > -1, `section "${heading}" is rendered`);
    assert.ok(at > lastIndex, `section "${heading}" keeps its position`);
    lastIndex = at;
  }
});

test("the legal site is served under /legal/* on the main host in all three languages", async () => {
  // German (default when no lang is given)
  const de = await fetch(`${base}/legal/impressum`);
  assert.equal(de.status, 200);
  assert.match(await de.text(), /Impressum/);

  // English
  const en = await fetch(`${base}/legal/impressum?lang=en`);
  assert.equal(en.status, 200);
  const enHtml = await en.text();
  assert.match(enHtml, /Imprint/);
  assert.match(enHtml, /Acme Test GmbH/, "LEGAL_COMPANY env value is rendered into the imprint");

  // Russian
  const ru = await fetch(`${base}/legal/datenschutz?lang=ru`);
  assert.equal(ru.status, 200);
  const ruHtml = await ru.text();
  assert.match(ruHtml, /Политика конфиденциальности/);
  assert.match(ruHtml, /Оператор данных/);
});

test("language switch is remembered in a cookie; unknown pages get a 404 page", async () => {
  // switching to English via ?lang=en sets the bf_legal_lang cookie…
  const first = await fetch(`${base}/legal/impressum?lang=en`);
  const cookie = (first.headers.getSetCookie?.() || []).join(";");
  assert.match(cookie, /bf_legal_lang=en/, "the language choice is persisted");

  // …and the same page WITHOUT ?lang now renders English (cookie is respected)
  const second = await fetch(`${base}/legal/impressum`, { headers: { Cookie: "bf_legal_lang=en" } });
  const secondHtml = await second.text();
  assert.match(secondHtml, /Imprint \(Legal Notice\)/);

  // unknown path on the legal site is a real 404 page, not the app
  const missing = await fetch(`${base}/legal/nope`);
  assert.equal(missing.status, 404);
  const missingHtml = await missing.text();
  assert.match(missingHtml, /404/);
});

test("the operator details and privacy-policy placeholders come from the settings", async () => {
  // The imprint renders the operator name and the commercial fields that ARE set…
  const impressum = await (await fetch(`${base}/impressum`)).text();
  assert.match(impressum, /Max Mustermann/, "LEGAL_NAME is rendered into the imprint");
  assert.match(impressum, /Acme Test GmbH/, "LEGAL_COMPANY is rendered when set");
  // …and drops the rows that are not (a private operator needs no register entry)
  assert.doesNotMatch(impressum, /Registereintrag/);
  assert.doesNotMatch(impressum, /Umsatzsteuer-ID/);

  // The privacy policy fills in the Datenschutz placeholders
  const de = await (await fetch(`${base}/datenschutz`)).text();
  assert.match(de, /Max Mustermann/);
  assert.match(de, /7 Tage/);
  assert.match(de, /Hetzner Online GmbH/);
  assert.match(de, /technisch notwendige Session-Cookies/);
  // an optional line with no value disappears instead of printing a gap, but
  // its section stays — the deployment sections are always present
  assert.doesNotMatch(de, /\[Dienst und Land\]/, "no placeholder leaks for an unset optional value");
  assert.match(de, /<li>IP-Adresse des anfragenden Geräts<\/li>/);
  assert.doesNotMatch(de, /<li>\s*<\/li>/, "dropped optional list items leave no empty <li>");

  // English and Russian translations carry the same values
  const en = await (await fetch(`${base}/datenschutz?lang=en`)).text();
  assert.match(en, /Max Mustermann/);
  assert.match(en, /Hetzner Online GmbH/);
  const ru = await (await fetch(`${base}/datenschutz?lang=ru`)).text();
  assert.match(ru, /Max Mustermann/);
  assert.match(ru, /Hetzner Online GmbH/);
});

test("the legal subdomain (Host-header routing) serves only the legal site", async () => {
  // Host: info.example.test → the legal index page
  const index = await getWithHost(LEGAL_HOST, "/");
  assert.equal(index.status, 200);
  assert.match(index.body, /Rechtliche Informationen/);

  // …and a doc page on that host, in the requested language
  const imprint = await getWithHost(LEGAL_HOST, "/impressum?lang=en");
  assert.equal(imprint.status, 200);
  assert.match(imprint.body, /Imprint/);

  // the removed document is not served there either
  const agb = await getWithHost(LEGAL_HOST, "/agb");
  assert.equal(agb.status, 404);

  // the legal host never exposes the API: unknown paths are a 404 legal page
  const apiOnLegal = await getWithHost(LEGAL_HOST, "/api/workflows");
  assert.equal(apiOnLegal.status, 404);
  assert.doesNotMatch(apiOnLegal.body, /"error"/, "no JSON API response leaks onto the legal host");

  // a different host keeps serving the normal app (not the legal site)
  const main = await getWithHost("example.test", "/");
  assert.doesNotMatch(main.body, /Rechtliche Informationen/);
});

test("the legal pages are reachable on the derived subdomain when none is configured", async () => {
  // a second server without BF_LEGAL_DOMAIN derives info.<site domain>
  const p2 = await freePort();
  const child2 = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(p2),
      BF_DB_PATH: path.join(tempDir, "derived.db"),
      BF_DATA_DIR: path.join(tempDir, "derived-data"),
      BF_SITE_DOMAIN: "flow.example.org",
      // a private operator: a name, no company
      LEGAL_COMPANY: "",
      LEGAL_NAME: "Erika Beispiel",
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child2.stdout.on("data", () => {});
  child2.stderr.on("data", () => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p2}/api/auth/config`);
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: p2, path: "/impressum", headers: { Host: "info.flow.example.org" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /Impressum/);
    // "back to the app" leaves the legal subdomain for the app's own domain
    assert.match(r.body, /<a class="back" href="https:\/\/flow\.example\.org\/">/);
    assert.doesNotMatch(r.body, /href="https:\/\/info\.flow\.example\.org\/"/);
    // without a company the copyright line names the operator, never a placeholder
    assert.match(r.body, /© \d{4} Erika Beispiel ·/);
    assert.doesNotMatch(r.body, /\[Firmenname\]/);
  } finally {
    child2.kill("SIGTERM");
    await new Promise((resolve) => {
      child2.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
});
