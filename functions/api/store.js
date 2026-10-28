/**
 * Meridian's sync store: your board kept in a D1 database on your own
 * Cloudflare account, so every device stays in step and nothing depends on
 * one browser's storage.
 *
 * Setup (Cloudflare dashboard, once):
 *   1. Create a D1 database (any name).
 *   2. Pages project → Settings → Bindings → add a D1 binding named DB.
 *   3. Pages project → Settings → Variables and secrets → add a secret named
 *      SYNC_KEY holding a long passphrase. Redeploy so both take effect.
 *
 * Every request except the ping must carry that passphrase in the
 * X-Meridian-Key header. The table is created on first use.
 *
 *   GET  ?ping=1                 -> {ok, configured, now}   (no key needed)
 *   GET  ?check=1                -> {ok, now}               (is the key right?)
 *   GET  ?path=<p>               -> {exists, doc}
 *   GET  ?since=<ms>             -> {now, docs:[{path, doc, updated}]}
 *   POST {op:"set", path, doc}   -> {ok, updated}
 *   POST {op:"acquire", path, holder, ttlMs} -> {acquired, expiresAt}
 */

const MAX_DOC_BYTES = 262144;          // 256 KiB, the same cap the app enforces
const PATH_RE = /^data\/users\/me\/[A-Za-z0-9_\-.:]{1,120}$/;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS docs (" +
    " path TEXT PRIMARY KEY," +
    " body TEXT," +                       // null = a lease row for a document not written yet
    " updated INTEGER NOT NULL DEFAULT 0," +
    " lease_holder TEXT," +
    " lease_until INTEGER" +
    ")"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated)").run();
  schemaReady = true;
}

export async function onRequest({ request, env }) {
  const here = new URL(request.url);

  // Browsers label requests made by other sites; refuse those. Opening a link
  // to this address is fine: the page that held the link can't read the result.
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  if ((origin && origin !== here.origin) || (site === "cross-site" && mode !== "navigate")) {
    return json({ error: "Requests from other sites aren't allowed" }, 403);
  }

  const configured = !!(env.DB && env.SYNC_KEY);
  if (request.method === "GET" && here.searchParams.has("ping")) return json({ ok: true, configured, now: Date.now() });
  if (!configured) return json({ error: "Sync isn't set up on this deployment", code: "not_configured" }, 503);

  if (!sameSecret(request.headers.get("X-Meridian-Key") || "", env.SYNC_KEY)) {
    return json({ error: "Wrong passphrase", code: "bad_key" }, 401);
  }

  const db = env.DB;
  try {
    await ensureSchema(db);

    if (request.method === "GET") {
      if (here.searchParams.has("check")) return json({ ok: true, now: Date.now() });

      const path = here.searchParams.get("path");
      if (path !== null) {
        if (!PATH_RE.test(path)) return json({ error: "Bad path", code: "invalid_argument" }, 400);
        const row = await db.prepare("SELECT body FROM docs WHERE path = ?").bind(path).first();
        if (!row || row.body === null) return json({ exists: false });
        return json({ exists: true, doc: JSON.parse(row.body) });
      }

      if (here.searchParams.has("since")) {
        const since = Math.max(0, parseInt(here.searchParams.get("since"), 10) || 0);
        const now = Date.now();
        const res = await db.prepare(
          "SELECT path, body, updated FROM docs WHERE body IS NOT NULL AND updated >= ? ORDER BY updated LIMIT 200"
        ).bind(since).all();
        const docs = (res.results || []).map(r => ({ path: r.path, doc: JSON.parse(r.body), updated: r.updated }));
        return json({ now, docs });
      }
      return json({ error: "Nothing asked for", code: "invalid_argument" }, 400);
    }

    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body isn't JSON", code: "invalid_argument" }, 400); }
      const path = body && body.path;
      if (!PATH_RE.test(String(path))) return json({ error: "Bad path", code: "invalid_argument" }, 400);

      if (body.op === "set") {
        if (!body.doc || typeof body.doc !== "object" || Array.isArray(body.doc)) {
          return json({ error: "A document must be an object", code: "invalid_argument" }, 400);
        }
        const text = JSON.stringify(body.doc);
        if (new TextEncoder().encode(text).length > MAX_DOC_BYTES) {
          return json({ error: "Document is over 256 KB", code: "invalid_argument" }, 413);
        }
        const updated = Date.now();
        await db.prepare(
          "INSERT INTO docs (path, body, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET body = excluded.body, updated = excluded.updated"
        ).bind(path, text, updated).run();
        return json({ ok: true, updated });
      }

      if (body.op === "acquire") {
        // Set-if-not-busy: one writer at a time per document, so two devices
        // saving at the same instant take turns instead of overwriting.
        const holder = String(body.holder || "").slice(0, 100);
        if (!holder) return json({ error: "Missing holder", code: "invalid_argument" }, 400);
        const ttl = Math.min(600000, Math.max(1000, parseInt(body.ttlMs, 10) || 30000));
        const now = Date.now(), until = now + ttl;
        const res = await db.prepare(
          "INSERT INTO docs (path, body, updated, lease_holder, lease_until) VALUES (?, NULL, 0, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET lease_holder = excluded.lease_holder, lease_until = excluded.lease_until " +
          "WHERE docs.lease_until IS NULL OR docs.lease_until < ? OR docs.lease_holder = excluded.lease_holder"
        ).bind(path, holder, until, now).run();
        const won = !!(res.meta && res.meta.changes > 0);
        if (won) return json({ acquired: true, expiresAt: new Date(until).toISOString(), holder });
        const row = await db.prepare("SELECT lease_until FROM docs WHERE path = ?").bind(path).first();
        return json({ acquired: false, expiresAt: new Date((row && row.lease_until) || now).toISOString() });
      }
      return json({ error: "Unknown op", code: "invalid_argument" }, 400);
    }

    return json({ error: "GET or POST only" }, 405);
  } catch (e) {
    return json({ error: "Database error", code: "unavailable", detail: String(e && e.message || e) }, 500);
  }
}

/** Compare without leaking how many characters matched. */
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
