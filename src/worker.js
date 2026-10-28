/**
 * Meridian as a Cloudflare Worker.
 *
 * Files in /public (the app) are served directly. Anything else reaches this
 * script, which hands /api/proxy and /api/store to their handlers.
 */
import { onRequest as proxy } from "../functions/api/proxy.js";
import { onRequest as store } from "../functions/api/store.js";
import { takeSnapshot } from "./snapshot.js";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api/proxy") return proxy({ request, env, ctx });
    if (path === "/api/store") return store({ request, env, ctx });
    return env.ASSETS.fetch(request);
  },

  // Daily net worth snapshot (schedule in wrangler.jsonc).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(takeSnapshot(env, { now: event.scheduledTime }).then(
      r => console.log("snapshot", JSON.stringify(r)),
      e => console.error("snapshot failed", e && e.stack || e)
    ));
  }
};
