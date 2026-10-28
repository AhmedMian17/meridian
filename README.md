# Meridian

Personal board: portfolio with live prices, net worth, budget, habits, training splits, nutrition and reminders.

One HTML file plus one Cloudflare Pages Function. No build step, no dependencies.

```
index.html               the whole app
functions/api/proxy.js   price proxy, served at /api/proxy
functions/api/store.js   sync database, served at /api/store
```

## Deploying

Cloudflare Pages, connected to this repo:

- **Framework preset:** None
- **Build command:** *(leave empty)*
- **Build output directory:** `/`

Every push to `main` deploys automatically, usually in under a minute.

## Live prices

The app checks for `/api/proxy` when it opens. If it answers, live prices switch on by themselves and refresh every five minutes; the Portfolio page offers one click to move hand-priced shares onto Yahoo.

Yahoo symbols: US shares as-is (`NVDA`, `VOO`), ASX with `.AX` (`BHP.AX`), crypto as `BTC-USD`.

Check the proxy is reaching Yahoo by opening:

```
https://<your-site>.pages.dev/api/proxy?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL
```

A page of JSON means it works. If Yahoo ever starts refusing, add a free Twelve Data key in Settings and switch positions to that source — the free plan covers US shares.

The proxy forwards only to a fixed list of finance hosts and refuses requests from other websites.

## Your data and sync

With sync set up, your board lives in a D1 database on your own Cloudflare account. Every device keeps a copy, works offline, and catches up when it reconnects; edits from two devices at once are merged.

One-time setup in the Cloudflare dashboard:

1. **Storage & Databases → D1 → Create database.** Any name, e.g. `meridian`.
2. **Workers & Pages → your project → Settings → Bindings → Add → D1 database.** Variable name `DB`, pick the database.
3. **Settings → Variables and secrets → Add.** Type *Secret*, name `SYNC_KEY`, value a long passphrase you'll remember.
4. **Deployments → latest → Retry deployment** (or push anything) so both take effect.

Open the site and it asks for the passphrase once per device. To lock every device out, change `SYNC_KEY` and redeploy; each device keeps its own copy and asks again.

Without the database set up, everything stays in each browser separately. Settings → Export everything gives you a backup file either way.

Inside claude.ai, the same file keeps your data in your Claude account instead, but can't fetch live prices.
