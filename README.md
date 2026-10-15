# Arhip Archive — Mercari Auto-Buyer (pnpm Monorepo)

Automated Mercari purchasing via a j-subculture.com proxy account, driven by
Playwright. Exposes an HTTP admin API and a Telegram bot for end-user access.

---

## Monorepo layout

```
packages/
  core/   — JsubClient, Session, pricing, PurchaseQueue, validation, ResearchLog/Reader, Config
  db/     — SQLite (better-sqlite3): schema migration, UsersRepo, BalancesRepo, PurchasesRepo
  api/    — Fastify HTTP server, /admin/* routes, web console (packages/api/public/index.html)
  bot/    — grammY Telegram bot (long-polling)
scripts/
  login.ts              — one-time headed login (run locally; solves reCAPTCHA)
  check.ts              — verify session liveness
  dump-purchase.ts      — dump purchase page HTML to artifacts/ for inspection
  import-legacy-ledger.ts — one-shot migration of data/ledger.json → purchases table
extension/              — MV3 browser extension for cookie sync (session refresh)
data/                   — SQLite db, research log (gitignored)
artifacts/              — Playwright run output (gitignored)
.pw-user/               — Playwright storageState.json (gitignored)
```

---

## Setup

Requires **Node 20+** and **pnpm 9** (`corepack enable` installs pnpm from `packageManager`).

```bash
corepack enable
pnpm install
npx playwright install chromium
cp .env.example .env   # fill in required vars (see Env vars section below)
```

### One-time login (headed — human solves reCAPTCHA)

Run this **locally** (not on a headless server). The session file is then copied
to the server.

```bash
npx tsx scripts/login.ts   # opens a real browser; sign in by hand; closes on success
npx tsx scripts/check.ts   # -> { loggedIn: true, username: "..." }
```

`scripts/dump-purchase.ts <item_url>` dumps the purchase page to `artifacts/` so
you can confirm the Plan A radio value.

---

## Running

```bash
# API server (HTTP + admin console):
pnpm --filter @arhip/api start
# or from root:
pnpm start:api

# Telegram bot (long-polling):
pnpm --filter @arhip/bot start
# or from root:
pnpm start:bot
```

Both services share a single SQLite file (`SQLITE_PATH`, default `data/app.db`).
Run them simultaneously; SQLite WAL mode handles concurrent access.

---

## API server and web console

The API listens on `0.0.0.0:$PORT` (default 8787). Every route except
`GET /health` and `GET /` requires `Authorization: Bearer <API_TOKEN>`.

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness — `{ ok: true }` |
| `GET /` | web console (`packages/api/public/index.html`) |
| `GET /session` | `{ loggedIn, username }` |
| `POST /session/login` | launch headed login (blocks on human) |
| `POST /session/logout` | delete saved session |
| `POST /session/import` | receive cookies from extension → `{ importedCookies, authValidUntil }` |
| `POST /item/preview` | `{ url }` → `{ title, priceJPY, plans[], balanceHint }` — no purchase |
| `POST /item/buy` | `{ url, plan?, maxPriceJPY? }` → `{ status, finalUrl }` |
| `GET /research/runs?limit=50` | recent run records |
| `GET /research/runs/:runId` | one run detail (HTML + network log) |
| `GET /admin/users` | list all users |
| `POST /admin/users/:id/activate` | activate a pending user |
| `POST /admin/users/:id/block` | block a user |
| `POST /admin/users/:id/topup` | add RUB balance — body: `{ amountRub: number, note?: string }` |
| `GET /admin/users/:id/txns` | balance transaction history |

`status` ∈ `bought` | `insufficient_balance` | `price_exceeded` | `error`.
Default plan is **Plan A (150 JPY/order)**.

---

## Admin web console

`GET /` serves the single-page console (no build step). Paste a Mercari URL →
**Preview**, then **Buy** (with `maxPriceJPY` + confirm). Session badge shows
login state.

The `/admin/*` endpoints are also reachable from the console — activate users,
view balances, and top up RUB. **Balances are topped up by the admin only**,
never via the Telegram bot.

---

## Telegram bot — user flow

1. User sends `/start` → account created in `pending` state; told to await activation.
2. Admin activates via `POST /admin/users/:id/activate` (web console or curl) and
   tops up RUB via `POST /admin/users/:id/topup`.
3. User sends a Mercari item URL → bot fetches a preview (title / JPY price / RUB
   total) and shows two inline buttons: **Купить за X ₽** and **Отмена**.
4. User taps **Buy** → bot holds the cost from their balance, queues the purchase,
   and executes via Playwright.
   - Success: balance finalized, purchase recorded, bot confirms.
   - Failure / price exceeded: balance refunded, failure reported.
5. User sends `/balance` → current RUB balance.
6. User sends `/orders` → their last 10 purchases (item, JPY price / RUB cost, status, date).

The purchase queue serializes all buys (one at a time), preventing concurrent
Playwright sessions.

### Bot admin commands

Gated by `TELEGRAM_ADMIN_IDS` (env + restart to change the admin list); silently
ignored for everyone else. Mirror the web console:

- `/users` — list users (id, @username, status, balance)
- `/activate <id>` / `/block <id>`
- `/topup <id> <amountRub>`
- `/pricing` — show current pricing; `/rate <v>`, `/markup <v>` (fraction), `/fee <v>` — live overrides

---

## Money model

All balances are stored as **integer kopecks** (1 RUB = 100 kopecks). No floats
are persisted anywhere.

Cost calculation (in `@arhip/core/pricing.ts`):

```
costKopecks = round( (priceJPY + PLAN_FEE_JPY) × RUB_PER_JPY × (1 + MARKUP) × 100 )
```

| Parameter | Env var | Default |
|---|---|---|
| Exchange rate | `RUB_PER_JPY` | `0.68` |
| Markup fraction | `MARKUP` | `0` (= 0%) |
| Plan fee (JPY) | `PLAN_FEE_JPY` | `400` |

The env vars set the **defaults**. Admins can retune them live from the bot
(`/rate`, `/markup`, `/fee`, `/pricing` to show current) — overrides are stored in
the `settings` table and layered over the env defaults, no restart needed.
With the defaults, cost = `(priceJPY + 400) × 0.68`.

The hold/refund flow is atomic (SQLite transactions). A failed or network-error
purchase always returns the held amount to the user's balance.

---

## Env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `JSUB_USERNAME` | yes | — | j-subculture.com username (login script only) |
| `JSUB_PASSWORD` | yes | — | j-subculture.com password (login script only) |
| `TELEGRAM_BOT_TOKEN` | yes (bot) | — | BotFather token |
| `SQLITE_PATH` | no | `data/app.db` | path to SQLite database |
| `RUB_PER_JPY` | no | `0.55` | JPY → RUB exchange rate |
| `MARKUP` | no | `0.10` | markup fraction (e.g. `0.10` = 10%) |
| `PLAN_FEE_JPY` | no | `150` | jsub Plan A fixed fee in JPY |
| `TELEGRAM_ADMIN_IDS` | no | — | comma-separated Telegram IDs with admin access |
| `PORT` | no | `8787` | HTTP port |
| `API_TOKEN` | no | auto-generated | Bearer token for all non-public routes. If unset, a strong one is generated on first start and saved to `data/api-token` (printed once in the logs). |
| `STORAGE_STATE_PATH` | no | `.pw-user/storageState.json` | Playwright session file |
| `RESEARCH_LOG_PATH` | no | `data/log.ndjson` | research NDJSON log |
| `RUNS_DIR` | no | `artifacts/runs` | per-run HTML + network dumps |
| `PROXY_URL` | no | — | SOCKS5/HTTP proxy for Playwright (e.g. `socks5://127.0.0.1:1080`) |
| `JSUB_BASE_URL` | no | `https://www.j-subculture.com` | override for testing |

---

## Testing

```bash
pnpm test                 # unit tests (no browser, no network) — 67 tests
pnpm test:integration     # integration: drives the dummy 0-balance account;
                          # asserts buy attempt = insufficient_balance.
                          # Needs a saved session. Never spends money.
```

---

## Legacy ledger migration

If a `data/ledger.json` file exists (`{ "bought": ["url", ...] }`) from the
pre-DB era, run once to import it:

```bash
npx tsx scripts/import-legacy-ledger.ts
```

Safe to re-run — duplicate `bought` inserts are silently ignored (partial unique
index on `purchases.mercari_url WHERE status = 'bought'`).

---

## Refreshing the session — browser extension

The j-subculture login is guarded by reCAPTCHA and the critical auth cookie is
**httpOnly** (a bookmarklet cannot read it). The session is refreshed with the
MV3 extension in `extension/`, which the operator runs roughly once per 30 days
(the login-status cookie lifetime):

1. Load `extension/` as an unpacked extension (chrome://extensions → Developer
   mode → Load unpacked).
2. Open the popup; set the **Server URL** and **API token**, then Save.
3. Log in on j-subculture.com, then click **Sync session** — it reads all cookies
   (including httpOnly via `chrome.cookies`) and POSTs them to `/session/import`.
   The running server picks up the new session without a restart.

Cookies are not IP-bound, so a session captured in the operator's residential
browser works from a server egressing through the proxy.

---

## Deploy (Docker — step by step)

The app runs as two Docker containers (**api** + **bot**) from one
`docker-compose.yml`. It's aimed at a non-expert: the only genuinely manual step
is the one-time login, because j-subculture's sign-in needs a human to solve a
reCAPTCHA.

### What you need

- A small always-on **Linux server** (VPS) you can SSH into.
- **Docker** (one-time install): `curl -fsSL https://get.docker.com | sh`
- Your **j-subculture** login, a **Telegram bot token** (from
  [@BotFather](https://t.me/BotFather)), and your **numeric Telegram id** for
  admin access (get it from [@userinfobot](https://t.me/userinfobot)).

### 1. Create the session locally (needs a real browser, once)

Do this on **your own computer**, not the server — a browser window opens:

```bash
pnpm install
npx playwright install chromium
cp .env.example .env         # fill JSUB_USERNAME / JSUB_PASSWORD
npx tsx scripts/login.ts     # browser opens — sign in + solve the captcha
npx tsx scripts/check.ts     # -> { loggedIn: true }
```

This produces `.pw-user/storageState.json` — the saved session.

### 2. Fill in `.env`

Edit `.env` (copied from `.env.example`) and set at least:

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_ADMIN_IDS` — your numeric Telegram id (comma-separated for several)
- `JSUB_USERNAME` / `JSUB_PASSWORD`

`API_TOKEN` is **optional** — leave it blank and the server generates a strong
one on first start (see step 5). Set it only if you want to pin your own.

### 3. Copy the project to the server

Put the whole project folder on the server, **including** your filled `.env` and
`.pw-user/storageState.json`. These are gitignored, so a plain `git clone` won't
carry them — copy with `rsync` (or `scp`):

```bash
rsync -az --exclude node_modules --exclude .git ./ user@SERVER:/opt/arhip/
```

### 4. Start it

```bash
ssh user@SERVER
cd /opt/arhip
docker compose up -d --build
docker compose logs -f          # watch it boot; Ctrl-C stops watching (keeps running)
```

### 5. Get your console password (the API token)

On the **first** start the logs print a generated token:

```
API_TOKEN was not set — generated one and saved it to data/api-token.
Use it to log into the console (keep it secret):

    <your-token>
```

It's saved in `data/api-token` and stays the same across restarts. Read it any
time with:

```bash
cat /opt/arhip/data/api-token
```

### 6. Open the console — over HTTPS, privately

The API listens on port **8787 without TLS**, so **don't** expose it to the raw
internet (your token would travel in clear text). Put a TLS tunnel in front. The
easiest option that needs **no domain** is **Tailscale** (private to your own
devices):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale serve --bg 8787       # serves HTTPS on your <machine>.ts.net name
```

Then open `https://<machine>.ts.net/` from any device on your tailnet and paste
the token from step 5. (Alternatives: **Cloudflare Tunnel** for a public
`*.trycloudflare.com` URL, or your own **domain + Caddy** for auto Let's Encrypt.)

### Notes

- **Egress proxy:** `docker-compose.yml` routes site traffic through a SOCKS
  tunnel (`PROXY_URL=socks5://127.0.0.1:1080`) so it reaches j-subculture from a
  WAF-clean IP. If your server can reach the site directly, comment out the two
  `PROXY_URL` lines in `docker-compose.yml`.
- **Two services:** **api** (Fastify on the `host` network at `$PORT`) and **bot**
  (grammY long-polling, no exposed ports). Both share one SQLite file via the
  `./data` volume.
- **Playwright base image:** keep `mcr.microsoft.com/playwright:v1.63.0-jammy` in
  sync with the `playwright` version in `packages/core/package.json`.
- **Session refresh (~monthly):** the login cookie expires; refresh it with the
  browser extension (see "Refreshing the session" above) or re-run step 1 and
  re-copy `storageState.json`, then `docker compose restart`.

---

## Safety notes

- `POST /item/buy` on a **funded** account spends real money and is irreversible.
  Guardrails: two-step preview/buy, `maxPriceJPY` ceiling, idempotency index
  (no double-buys on the same URL), and fail-closed selector handling.
- **Balances are topped up by the admin only** — via the web console or API.
  The Telegram bot has no topup command.
- Secrets live in `.env` (gitignored). Recon artifacts (`artifacts/`, `.pw-user/`)
  may contain cookies/credentials and are gitignored.
- The API **never runs unauthenticated**: if `API_TOKEN` is unset it is
  auto-generated on first start and saved to `data/api-token` (printed once in the
  logs). It listens over plain HTTP, so front it with a TLS tunnel (see Deploy,
  step 6) instead of exposing port 8787 directly.

---

## Open items to finalize on a live session

- Exact `plan_type_tmp` value for Plan A (default assumed `1`) — confirm with
  `scripts/dump-purchase.ts`.
- The success-page URL shape on a funded purchase — used to finalize the `bought`
  classifier in `packages/core/src/jsub/outcome.ts`.
- Crash-reconciliation on startup **is implemented**: `BalancesRepo.reconcileHolds()`
  runs once when the bot boots (`packages/bot/src/index.ts`) and refunds any `hold`
  left orphaned by a process killed mid-purchase — per `(telegram_id, url)`,
  `orphans = #holds − #refunds − #bought`, refunding the newest unmatched holds.
  It is idempotent (each refund appends a `refund` txn) and logs every refund.
