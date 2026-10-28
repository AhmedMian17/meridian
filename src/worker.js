/**
 * Meridian as a Cloudflare Worker.
 *
 * Files in /public (the app) are served directly. Anything else reaches this
 * script, which hands /api/proxy and /api/store to their handlers.
 */
import { onRequest as proxy } from "../functions/api/proxy.js";
import { onRequest as store } from "../functions/api/store.js";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api/proxy") return proxy({ request, env, ctx });
    if (path === "/api/store") return store({ request, env, ctx });
    return env.ASSETS.fetch(request);
  }
};
