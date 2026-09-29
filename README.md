# INE Price Tracker

A small full-stack app that tracks 20 items from INE's demo mock store. A scheduled scraper hits the store every 2 hours, logs every attempt (success, retried, or failed), and the dashboard reads that history straight out of the database.

## Architecture

<img width="1243" height="432" alt="image" src="https://github.com/user-attachments/assets/2dcb778c-f6e2-4bbe-99de-ee044f5b9751" />


- **Backend** Node.js script running locally. Exposes a protected endpoint that an external
  cron service calls every 2 hours to trigger a scrape run, since the free-tier backend sleeps
  and can't run its own always-on scheduler.
- **Scraping**: two-stage, described below.
- **Database**: Supabase (Postgres) — tracked products and the full scrape log live here. The
  frontend never talks to the store directly; it only reads from Supabase.
- **Frontend**: React, deployed on Vercel. Search/track UI, price/stock chart, per-product scrape
  log, and CSV export.

## Setup
`fetch_price.js` is sample one time run script that will yield the price and stock, the targeted item can be changed by changing the `DEFAULT_ITEM_URL` variable. 
`crawler.js` expects supabase variables in .env file in the shape provided in env_example.

```bash
npm install
node fetch_price # Will yield the price and stock for the item at DEFAULT_ITEM_URL
```

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | backend, frontend | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | Server-side writes to price/stock/log tables |

## Scraping Schedule

Each tracked product + option is scraped **once every 2 hours**. An internally running cron script calls `node crawler.js`. 

## The Two Real Problems

The most difficult part of the project was the crawling. Here are two real problems I faced alongside solutions.

### 1. The store doesn't render without JavaScript — the listing data comes from an internal API

A plain `fetch` of any page just returns the SPA's empty `index.html` shell; the real content is injected client-side after the bundle runs. Rather than reaching for a headless browser for *everything*, I inspected the app's own network traffic (DevTools → Network → Fetch/XHR) and found the app calls a versioned JSON API directly:

```
GET /api/v2/listings?page=1&limit=20   -> paginated product summaries
GET /api/v2/items/:id                  -> item detail (name, options, etc.)
```

These are called with plain `fetch`/HTTP, without the need for any headless browser. This keeps search, listing, and item-detail lookups fast and cheap.

<img width="1694" height="732" alt="image" src="https://github.com/user-attachments/assets/cf087a93-9e00-4483-bf21-a3d71b00dadd" />


### 2. Getting an actual price requires passing a real interaction + trust check

The price/stock for a given option isn't returned by the item API, it's only revealed after clicking a "Check today's price" control on the live page, and that flow is deliberately guarded:

- The click only becomes available after a **human-like hover pattern** on the price panel (the button stays disabled until a sustained sequence of pointer moves plus a dwell period is detected — a single instant hover or a raw click doesn't trigger it).
- The subsequent request also carries a **proof-of-work solve** (server-issued salt/difficulty, client computes a nonce, verified server-side) and a **browser-environment attestation payload** (canvas/WebGL fingerprint, screen/frame info, pointer-trust and dwell-timing signals).

To meet the above requirements we drive an actual Chromium instance with Playwright: it navigates to the item page, selects the requested option, performs a real multi-point hover over the price panel with a matching dwell time, and issues a
real click. Because the interaction is genuine rather than simulated, the browser produces valid proof-of-work and attestation values on its own; there's no separate value to construct or spoof.

<img width="1253" height="770" alt="image" src="https://github.com/user-attachments/assets/d6e4d932-dcf4-49ed-a34b-4dad2d513518" />



## Scrape Log & Export

Every scrape attempt — success, retried, or failed — is written to the log table with a UTC ISO timestamp. Failed attempts are stored with `price`/`stock` left empty; the scraper never writes a guessed or partial value on failure. The dashboard's Export button downloads the full log as CSV with one row per attempt: store product ID, product name, selected option, timestamp, price, stock, outcome.

## AI Tool Usage

AI tools (claude and codex) were used however each line of code was carefully read and understood and only then pushed. Much of the crawler logic was rewritten many times by hand.

## TODO
- Make scraper logic robust
- Host the backend on Render
- Change detection that flags when the page's structure changes
