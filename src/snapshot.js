/**
 * The daily net worth snapshot, taken by the Worker on a schedule so it happens
 * even when no device has the board open.
 *
 * It reads your board from the sync database, prices live holdings and
 * exchange rates the same way the app does, and adds one row to the net worth
 * history for the previous day (by default it runs after the US close, so that
 * row ends the day at closing prices). Devices pick it up like any change made
 * on another device.
 *
 * The arithmetic mirrors the app's: lots less what's been sold, × contract size
 * for options, short options negative, broker cash and margin, and accounts
 * with loans and cards counted as owed.
 */

const ME = "data/users/me/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NEG_TYPES = { loan: 1, card: 1 };
const KNOWN_TYPES = ["cash", "super", "property", "business", "vehicle", "loan", "card"];

/* ---------- small date helpers, in the board's own time zone ---------- */
function localDate(ms, tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ---------- prices ---------- */
async function getJSON(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function yahooQuote(symbol, fetchImpl) {
  const d = await getJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d", fetchImpl);
  const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!meta || !isFinite(meta.regularMarketPrice)) throw new Error("no quote");
  let v = meta.regularMarketPrice, cur = meta.currency;
  if (cur === "GBp" || cur === "ILA" || cur === "ZAc") { v = v / 100; cur = cur === "GBp" ? "GBP" : cur === "ILA" ? "ILS" : "ZAR"; }
  return { value: v, currency: cur };
}
async function livePrice(p, fetchImpl) {
  const src = p.source || {};
  if (src.type === "yahoo" && src.feedSymbol) return yahooQuote(src.feedSymbol, fetchImpl);
  if (src.type === "coingecko" && src.coinId) {
    const d = await getJSON("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(src.coinId) + "&vs_currencies=usd", fetchImpl);
    const v = d && d[src.coinId] && d[src.coinId].usd;
    if (!isFinite(v)) throw new Error("no quote");
    return { value: v, currency: "USD" };
  }
  if (src.type === "dexscreener" && src.address && src.chainId) {
    const d = await getJSON("https://api.dexscreener.com/tokens/v1/" + encodeURIComponent(src.chainId) + "/" + encodeURIComponent(src.address), fetchImpl);
    const pairs = (Array.isArray(d) ? d : (d && d.pairs) || []).filter(x => x && x.baseToken && String(x.baseToken.address).toLowerCase() === String(src.address).toLowerCase());
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const v = pairs[0] && parseFloat(pairs[0].priceUsd);
    if (!isFinite(v)) throw new Error("no quote");
    return { value: v, currency: "USD" };
  }
  return null;     // priced by hand
}

/* ---------- the board's arithmetic ---------- */
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };

export function computeNetWorth(board, prices) {
  const settings = board.settings || {}, portfolio = board.portfolio || {}, networth = board.networth || {};
  const base = settings.base || "AUD";
  const fx = Object.assign({}, settings.fx || {}, prices.fx || {});
  const rate = cur => (!cur || cur === base) ? 1 : (fx[cur] > 0 ? fx[cur] : null);

  const lots = portfolio.lots || [], disposals = portfolio.disposals || [];
  const soldByLot = {};
  disposals.forEach(d => { soldByLot[d.lotId] = (soldByLot[d.lotId] || 0) + num(d.qty); });

  let invest = 0;
  (portfolio.positions || []).forEach(p => {
    const live = prices.positions[p.id];
    const price = live ? live.value : (p.price && isFinite(p.price.value) ? p.price.value : null);
    const cur = (live && live.currency) || p.currency;
    const r = rate(cur);
    if (price === null || r === null) return;
    const mult = p.kind === "option" ? num((p.option && p.option.multiplier) || 100) || 100 : 1;
    const sign = p.kind === "option" && p.option && p.option.side === "short" ? -1 : 1;
    lots.filter(l => l.positionId === p.id).forEach(l => {
      const open = num(l.qty) - (soldByLot[l.id] || 0);
      if (open <= 1e-10) return;
      invest += sign * open * price * mult * r;
    });
  });

  const parts = { invest };
  let assets = invest, liabilities = 0;
  (networth.accounts || []).forEach(a => {
    if (a.exclude) return;
    const type = KNOWN_TYPES.indexOf(a.type) >= 0 ? a.type : "vehicle";
    const r = rate(a.currency || base);
    const v = (r === null ? 0 : num(a.value) * r) * (NEG_TYPES[type] ? -1 : 1);
    parts[type] = (parts[type] || 0) + v;
    if (v >= 0) assets += v; else liabilities += v;
  });
  (portfolio.cash || []).forEach(c => {
    const r = rate(c.currency || base);
    if (r === null) return;
    const v = num(c.amount) * r;
    if (v >= 0) { parts.cash = (parts.cash || 0) + v; assets += v; }
    else { parts.margin = (parts.margin || 0) + v; liabilities += v; }
  });
  Object.keys(parts).forEach(k => { if (Math.abs(parts[k]) < 0.005) delete parts[k]; else parts[k] = Math.round(parts[k] * 100) / 100; });
  const round = v => Math.round(v * 100) / 100;
  return { total: round(assets + liabilities), portfolio: round(invest), assets: round(assets), liabilities: round(liabilities), parts };
}

/** Live prices for open, auto-priced holdings and today's exchange rates. Anything that fails keeps its last known value. */
async function gatherPrices(board, fetchImpl) {
  const settings = board.settings || {}, portfolio = board.portfolio || {}, networth = board.networth || {};
  const base = settings.base || "AUD";
  const out = { positions: {}, fx: {}, missed: [] };
  const openIds = {};
  const sold = {};
  (portfolio.disposals || []).forEach(d => { sold[d.lotId] = (sold[d.lotId] || 0) + num(d.qty); });
  (portfolio.lots || []).forEach(l => { if (num(l.qty) - (sold[l.id] || 0) > 1e-10) openIds[l.positionId] = 1; });

  for (const p of portfolio.positions || []) {
    if (!openIds[p.id] || !p.source || !p.source.type || p.source.type === "manual") continue;
    try {
      const q = await livePrice(p, fetchImpl);
      if (q) out.positions[p.id] = q;
    } catch (e) { out.missed.push(p.symbol || p.id); }
  }
  const need = {};
  (portfolio.positions || []).forEach(p => { if (openIds[p.id]) need[(out.positions[p.id] && out.positions[p.id].currency) || p.currency] = 1; });
  (networth.accounts || []).forEach(a => { if (!a.exclude) need[a.currency || base] = 1; });
  (portfolio.cash || []).forEach(c => { need[c.currency || base] = 1; });
  delete need[base];
  for (const c of Object.keys(need)) {
    if (!/^[A-Z]{3}$/.test(c)) continue;
    try { const q = await yahooQuote(c + base + "=X", fetchImpl); if (q.value > 0) out.fx[c] = q.value; }
    catch (e) { out.missed.push(c + base); }
  }
  return out;
}

/* ---------- reading and writing the store ---------- */
async function readDoc(db, name) {
  const row = await db.prepare("SELECT body FROM docs WHERE path = ?").bind(ME + name).first();
  return row && row.body ? JSON.parse(row.body) : null;
}
async function lease(db, path, holder, ttl) {
  const now = Date.now();
  const res = await db.prepare(
    "INSERT INTO docs (path, body, updated, lease_holder, lease_until) VALUES (?, NULL, 0, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET lease_holder = excluded.lease_holder, lease_until = excluded.lease_until " +
    "WHERE docs.lease_until IS NULL OR docs.lease_until < ? OR docs.lease_holder = excluded.lease_holder"
  ).bind(path, holder, now + ttl, now).run();
  return !!(res.meta && res.meta.changes > 0);
}
async function release(db, path, holder) {
  await db.prepare("UPDATE docs SET lease_until = 0 WHERE path = ? AND lease_holder = ?").bind(path, holder).run();
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Take the snapshot. Options: date (YYYY-MM-DD; default the day before today in tz),
 * tz (default Australia/Sydney), now (ms), fetch (for tests).
 * Returns the row written, or {skipped: reason}.
 */
export async function takeSnapshot(env, opts = {}) {
  const db = env.DB;
  if (!db) return { skipped: "no database" };
  const fetchImpl = opts.fetch || fetch;
  const tz = opts.tz || env.SNAPSHOT_TZ || "Australia/Sydney";
  const now = opts.now || Date.now();
  const date = opts.date || addDays(localDate(now, tz), -1);

  let board;
  try {
    board = {
      settings: (await readDoc(db, "settings") || {}).data,
      portfolio: (await readDoc(db, "portfolio") || {}).data,
      networth: (await readDoc(db, "networth") || {}).data
    };
  } catch (e) { return { skipped: "store not set up yet" }; }
  if (!board.portfolio && !board.networth) return { skipped: "nothing stored yet" };

  const prices = await gatherPrices(board, fetchImpl);
  const nw = computeNetWorth(board, prices);
  const row = Object.assign({ date }, nw, { src: "auto" });
  if (prices.missed.length) row.est = true;

  // Take turns with devices saving at the same moment, exactly as they do with each other.
  const path = ME + "networth", holder = "cron";
  let got = false;
  for (let i = 0; i < 20 && !(got = await lease(db, path, holder, 8000)); i++) await wait(500);
  if (!got) return { skipped: "busy" };
  try {
    const cur = await readDoc(db, "networth");
    const data = (cur && cur.data) ? cur.data : { accounts: [], snapshots: [] };
    const snaps = (data.snapshots || []).filter(s => s.date !== date);
    snaps.push(row);
    snaps.sort((a, b) => a.date.localeCompare(b.date));
    data.snapshots = snaps.slice(-1200);
    const doc = { v: 2, rev: now.toString(36) + "-cron-" + Math.random().toString(36).slice(2, 7), at: now, by: "cron", tab: "cron", data };
    await db.prepare(
      "INSERT INTO docs (path, body, updated) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET body = excluded.body, updated = excluded.updated"
    ).bind(path, JSON.stringify(doc), Date.now()).run();
  } finally {
    await release(db, path, holder);
  }
  return row;
}
