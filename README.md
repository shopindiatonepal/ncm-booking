# NCM partner booking site

A tiny site where your partner books Nepal Can Move orders **without ever seeing your vendor login or API key**.

- Booking page: `/`   Bill page: `/bill`
- Zero dependencies. Needs Node 18+. Start with `node server.js`

## Settings (environment variables)

| Name | What it is |
|---|---|
| `NCM_TOKEN` | Your NCM API key. Leave empty = TEST MODE (nothing is sent to NCM) |
| `PASSCODE` | The passcode your partner types to open the site |
| `NCM_BASE_URL` | Default `https://portal.nepalcanmove.com`. NCM's sandbox uses a different address, ask NCM |
| `VREF_ID` | Default `31180` |

## Run locally
```
PASSCODE=mypass node server.js
```
Open http://localhost:3000

## Put it online (free): Render.com
1. Upload this folder to a GitHub repo.
2. Render -> New -> Web Service -> pick the repo. Build command: empty. Start command: `node server.js`.
3. Under Environment, add `PASSCODE` and later `NCM_TOKEN`.
4. Share the Render link and the passcode with your partner.

## Permanent storage (free): Upstash Redis
Render's free plan wipes the local order file on restart, so connect a free database:
1. Sign up at upstash.com -> Create Database (Redis, free plan).
2. On the database page, copy the **REST URL** and **REST TOKEN** (REST section, not the normal Redis URL).
3. In Render -> Environment, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
Orders, customer history and statuses then survive restarts and redeploys. Without these two settings, a local file is used.

## Tracking
Orders tab: search, tap an order to see its full courier status timeline and courier comments. "Refresh status" updates all undelivered orders from NCM.
