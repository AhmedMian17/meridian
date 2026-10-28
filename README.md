# Meridian

Personal board: portfolio with live prices, net worth, budget, habits, training splits, nutrition and reminders.

One HTML file and a small Cloudflare Worker. No build step.

```
public/index.html        the whole app
src/worker.js            routes /api/* to the handlers below, serves everything else from public/
functions/api/proxy.js   price proxy, at /api/proxy
functions/api/store.js   sync database, at /api/store
wrangler.jsonc           Worker settings (name, assets, D1 binding)
```

## Deploying

A Cloudflare Worker connected to this repo (Workers & Pages → Create → Import a repository). Every push to `main` deploys automatically, usually in under a minute.

The `name` in `wrangler.jsonc` must match the Worker's name in the dashboard.

## Live prices

The app checks for `/api/proxy` when it opens. If it answers, live prices switch on by themselves and refresh every five minutes; the Portfolio page offers one click to move hand-priced shares onto Yahoo.

Yahoo symbols: US shares as-is (`NVDA`, `VOO`), ASX with `.AX` (`BHP.AX`), crypto as `BTC-USD`.

US-listed options are priced from Yahoo too: the app builds the contract symbol from underlying, expiry, call/put and strike (NVDA $180 call, 18 Dec 2026 → `NVDA261218C00180000`). The price is the contract's last trade, so quiet contracts are flagged "stale price" when nothing has traded for over a day; any option can still be priced by hand.

Exchange rates come from Yahoo with every price refresh (`USDAUD=X`), falling back to the ECB's daily rates if Yahoo has none.

Check the proxy is reaching Yahoo by opening:

```
https://<your-site>.pages.dev/api/proxy?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL
```

A page of JSON means it works. If Yahoo ever starts refusing, add a free Twelve Data key in Settings and switch positions to that source — the free plan covers US shares.

The proxy forwards only to a fixed list of finance hosts and refuses requests from other websites.

## Your data and sync

With sync set up, your board lives in a D1 database on your own Cloudflare account. Every device keeps a copy, works offline, and catches up when it reconnects; edits from two devices at once are merged.

The database is created automatically on the first deploy (`d1_databases` in `wrangler.jsonc`). The only setup is the passphrase: **Workers & Pages → meridian → Settings → Variables and Secrets → Add**, type *Secret*, name `SYNC_KEY`, value a long passphrase you'll remember.

Open the site and it asks for the passphrase once per device. To lock every device out, change `SYNC_KEY`; each device keeps its own copy and asks again.

Without the database set up, everything stays in each browser separately. Settings → Export everything gives you a backup file either way.

Inside claude.ai, the same file keeps your data in your Claude account instead, but can't fetch live prices.
