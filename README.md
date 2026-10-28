# Meridian

Personal board: portfolio with live prices, net worth, budget, habits, training splits, nutrition and reminders.

One HTML file plus one Cloudflare Pages Function. No build step, no dependencies.

```
index.html               the whole app
functions/api/proxy.js   price proxy, served at /api/proxy
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

## Your data

Everything is stored in your browser, on each device separately — nothing is uploaded. Settings → Export everything gives you a backup file; Import restores it.

Inside claude.ai, the same file keeps your data in your Claude account instead, but can't fetch live prices.
