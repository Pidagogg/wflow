// ============================================================================
// W FLOW — sandbox worker for the JavaScript nodes (Code, JS Transform, Filter,
// Aggregate).
//
// This file is the CHILD process spawned by server/code-sandbox.js. It is
// launched with Node's permission model (--permission) and NO --allow-fs-* /
// --allow-child-process flags, so the user code it runs cannot read or write
// the filesystem, spawn processes, or start workers. It is started with a
// scrubbed environment too, so process.env holds none of the server's secrets
// (encryption key, DATABASE_URL, Stripe/SMTP keys, …). `fetch` stays available
// because the JS nodes are meant to call HTTP APIs — the only capability left.
//
// Protocol: the parent writes one JSON request to stdin and closes it; we write
// one JSON response to stdout and exit. Request: { kind, code, items }.
// Response: { ok:true, out } or { ok:false, error } (a hard failure the node
// should surface). JS Filter / Aggregate never hard-fail — they fold errors
// into the result exactly as the old in-process code did.
// ============================================================================

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => resolve(raw));
  });
}

function asItem(r) {
  return { json: r && typeof r === "object" && !Array.isArray(r) ? r : { result: r } };
}

async function run(req) {
  const { kind, code, items } = req;
  switch (kind) {
    case "jsTransform": {
      // eslint-disable-next-line no-new-func
      const fn = new Function("item", "index", '"use strict";\n' + (code || "return item;"));
      const out = items.map((item, i) => asItem(fn(item.json, i)));
      return { ok: true, out };
    }
    case "jsFilter": {
      // eslint-disable-next-line no-new-func
      const fn = new Function("item", "index", '"use strict";\nreturn (\n' + (code || "true") + "\n);");
      const out = items.filter((item, i) => {
        try {
          return !!fn(item.json, i);
        } catch {
          return false;
        }
      });
      return { ok: true, out };
    }
    case "jsAggregate": {
      // eslint-disable-next-line no-new-func
      const fn = new Function("acc", "item", "index", '"use strict";\n' + (code || "return acc;"));
      let acc = {};
      items.forEach((item, i) => {
        try {
          const r = fn(acc, item.json, i);
          if (r !== undefined) acc = r;
        } catch (err) {
          acc.error = String(err.message || err);
        }
      });
      return { ok: true, out: [{ json: acc }] };
    }
    case "code": {
      // wrapped in an async IIFE so user code may use await (fetch etc.)
      // eslint-disable-next-line no-new-func
      const fn = new Function("items", '"use strict";\nreturn (async () => {\n' + (code || "return items;") + "\n})();");
      const result = await fn(items);
      const out = Array.isArray(result) ? result : [{ json: { result } }];
      return { ok: true, out };
    }
    default:
      return { ok: false, error: `Unknown sandbox kind: ${kind}` };
  }
}

(async () => {
  let res;
  try {
    const req = JSON.parse(await readStdin());
    res = await run(req);
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  try {
    process.stdout.write(JSON.stringify(res, replacer));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "The node returned a value that cannot be serialised to JSON." }));
  }
})();

// User code can return things JSON.stringify chokes on (BigInt, functions,
// circular refs). BigInt becomes a string; functions/undefined drop out the
// normal JSON way; a circular structure throws and is reported as above.
function replacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
