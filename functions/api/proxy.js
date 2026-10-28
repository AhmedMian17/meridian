/**
 * Meridian's price proxy, deployed with the app as a Cloudflare Pages Function
 * at /api/proxy.
 *
 * Browsers won't let a page read price APIs that don't opt in — Yahoo
 * deliberately doesn't. This fetches them from Cloudflare's servers instead,
 * where that rule doesn't apply. Because it lives on the same site as the app,
 * the app finds it on its own; there's nothing to configure.
 *
 *   /api/proxy?ping=1            -> {"ok":true,"proxy":"meridian"}
 *   /api/proxy?url=<https URL>   -> that URL's response
 *
 * Only the hosts below are forwarded, so it can't be used as a general relay,
 * and requests from other websites are refused so nobody else can spend your
 * free request allowance from their page.
 */

const ALLOWED_HOSTS = [
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "api.twelvedata.com",
  "finnhub.io",
  "api.coingecko.com",
  "api.dexscreener.com",
  "api.frankfurter.dev"
];

const CACHE_SECONDS = 30;

export async function onRequest({ request }) {
  const here = new URL(request.url);

  if (request.method !== "GET") return json({ error: "GET only" }, 405);

  // Browsers label requests made by other sites; refuse those. Opening a link
  // to this address is fine: the page that held the link can't read the result.
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  if ((origin && origin !== here.origin) || (site === "cross-site" && mode !== "navigate")) {
    return json({ error: "Requests from other sites aren't allowed" }, 403);
  }

  if (here.searchParams.has("ping")) return json({ ok: true, proxy: "meridian" });

  const target = here.searchParams.get("url");
  if (!target) return json({ error: "Add ?url=<the request to forward>" }, 400);

  let dest;
  try { dest = new URL(target); } catch { return json({ error: "That isn't a URL" }, 400); }
  if (dest.protocol !== "https:") return json({ error: "https only" }, 400);
  if (!ALLOWED_HOSTS.includes(dest.hostname)) return json({ error: "Host not allowed: " + dest.hostname }, 403);

  let res;
  try {
    res = await fetch(dest.toString(), {
      headers: {
        // Yahoo turns away requests that don't look like a browser.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-AU,en;q=0.9"
      },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
    });
  } catch (e) {
    return json({ error: "Couldn't reach " + dest.hostname, detail: String(e) }, 502);
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=" + CACHE_SECONDS
    }
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
