# ANALYSIS.md — Pingflare Deep Analysis & Unified Architecture Design

> Phase 1 deliverable. Read this before touching code.
> Reference repo cloned at `_reference_pingflare/` (read-only, `.git` removed after analysis).

---

## 1. Original Pingflare — What It Actually Is

Pingflare is a **self-hosted uptime monitor that runs entirely on Cloudflare Workers + D1**.
Reference: <https://github.com/isala404/pingflare> (MIT). Analysed at commit on `master`.

### 1.1 Stack (verified from `package.json` / `wrangler.toml`)

| Layer | Choice |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 (`@sveltejs/adapter-cloudflare`) |
| Build | Vite 7 + Tailwind 4 + `esbuild` |
| Runtime | Cloudflare Workers, `compatibility_date = 2025-11-17`, `nodejs_compat` |
| Storage | D1 (SQLite) only |
| Scheduling | Cron trigger `*/1 * * * *` |
| Pkg manager | `bun` (`bun.lock`) |
| Deployment | Workers Static Assets: `main = dist/_worker.js`, `[assets] directory = dist` |

### 1.2 The Clever Deployment Trick (worth copying)

Next.js/SvelteKit adapters normally emit a `fetch` handler only. Pingflare needs **cron**, so
`scripts/build-worker.js` does this after `vite build`:

1. Takes the adapter output `.svelte-kit/cloudflare/_worker.js`.
2. Generates a **wrapper** module that re-exports `.fetch` and adds a `scheduled()` handler.
3. Bundles wrapper → `dist/_worker.js` with esbuild.
4. Copies every *other* file from `.svelte-kit/cloudflare/` into `dist/` so Workers Static Assets
   can serve them.

Then `scheduled()` fabricates a request to `/api/cron` carrying `X-Cron-Secret` and calls the SvelteKit
handler. So **there is only one Worker** doing UI + API + cron. That is the architectural seed for
our whole project.

### 1.3 Request Flow

```
Browser ─┬─ GET /            → hooks.server.ts (session) → +page.server.ts → D1
         ├─ GET /status/[slug]→ public status page → D1 (daily_status aggregates)
         └─ POST /api/monitors → hooks.server.ts (auth) → zod-less hand validation → D1

Cron */1min ─→ Worker.scheduled() ─→ synthetic GET /api/cron (X-Cron-Secret)
                                        │
                                        ├─ getActiveMonitors(D1)
                                        ├─ for each: runCheck(monitor)  ← multi-step DSL
                                        ├─ insertCheck(...)
                                        ├─ on status change → sendNotifications()
                                        └─ at 00:00 UTC → aggregateDailyStatus() + cleanup
```

### 1.4 The Health-Check DSL (its real differentiator)

`src/lib/server/checkers/script.ts` implements a **declarative JSON check language**, not a plain
HTTP ping. It supports:

- Chained steps: `GET/POST/PUT/PATCH/DELETE`
- `extract` — pull values out of a response by dot-path (`json.token`) into `${var}` placeholders
- `assert` — compare `status`, `json.*`, headers, response time with `equals`, `greaterThan`, `contains`, …
- Severity mapping: a failing assertion can be `degraded` or `down`
- A visual builder UI (`ScriptBuilder.svelte`, 22 KB) that emits the JSON

This is what lets it monitor *flows* (login → token → call API) rather than single URLs.
**We keep this concept and improve it** (allowlist enforcement, redirect cap, size cap).

### 1.5 Data Model (`migrations/0001_schema.sql`)

11 tables: `monitor_groups`, `monitors`, `checks`, `daily_status`, `incidents`,
`incident_updates`, `notification_channels`, `monitor_notifications`, `push_subscriptions`,
`users`, `sessions`, `app_settings`.

Smart bit: **dual-granularity history**. Raw `checks` rows are kept only 7 days; `daily_status`
holds 90 days of pre-aggregated uptime so the 90-day bar chart is ~90 rows, not ~129,600.

### 1.6 Notifications

`webhook`, `slack`, `discord`, `webpush` (real VAPID web-push, 9 KB module). Fired **only on
status transition**, not on every failed check — that is deliberate spam avoidance.
`monitor_notifications` supports `notify_on` (`down,up`) and `downtime_threshold_s`.

---

## 2. Gaps We Fix (the "enhanced" part)

| # | Issue in original | Severity | Our fix |
|---|---|---|---|
| 1 | **Unsalted SHA-256 password hash** (`crypto.subtle.digest('SHA-256')`, `auth.ts`) | 🔴 Critical | PBKDF2-SHA256, 210k iters, 16-byte random salt, versioned `pbkdf2$…` format |
| 2 | Password compared with `===` (no constant-time compare) | 🟠 High | `crypto.subtle.verify` / `timingSafeEqual` |
| 3 | **No rate limiting anywhere** — login is brute-forceable | 🔴 Critical | Workers Rate Limiting binding + Hono in-memory limiter + auth-specific lockout |
| 4 | **No security headers at all** — no CSP/HSTS/X-Frame-Options | 🔴 Critical | Hono `secureHeaders` + nonce CSP, HSTS, frame-ancestors |
| 5 | **No input validation** — hand-rolled checks, params interpolated | 🟠 High | Zod v4 on **every** route via `@hono/zod-validator` |
| 6 | **D1 only** — hard vendor lock-in | 🟠 High | `DatabaseAdapter` interface, 6 providers, `DB_PROVIDER` switch |
| 7 | Cron secret compared with `!==`, no rotation | 🟡 Med | HMAC-SHA256 comparison + `CRON_SECRET` versioning |
| 8 | Health-check DSL **fetches any URL** → SSRF into Cloudflare metadata / private ranges | 🔴 Critical | URL validator: scheme allowlist, DNS-resolved IP private-range block, redirect cap, response size cap |
| 9 | No 2FA | 🟡 Med | TOTP (RFC 6238, HMAC-SHA1, via WebCrypto) — optional |
| 10 | No IP allowlisting on admin | 🟡 Med | `ADMIN_IP_ALLOWLIST` env (CIDR + exact) |
| 11 | No CORS control | 🟡 Med | Env-driven origin allowlist |
| 12 | No live map | 🟢 Missing | Leaflet + dark OSM tiles, edge-node markers, pulse animations |
| 13 | No charts (only SVG bars) | 🟢 Missing | Recharts — uptime area, latency line, sparklines |
| 14 | Free-tier hostile: cron uses a subrequest per check | 🟠 High | Staggered check windows + concurrency cap + batched `INSERT` |
| 15 | No local Docker path | 🟢 Missing | `docker compose up` → Node + SQLite, same code |
| 16 | Status page is fully client-rendered | 🟡 Med | Pre-rendered HTML shell + `<meta>` OG tags for shareability |

---

## 3. 🚩 Blocker A — `@tundralibs/drivers` Does Not Exist

The brief said: *"Use `@tundralibs/drivers` or `cf-knex` as the connector."*

I queried the npm registry directly:

```
FAIL  | @tundralibs/drivers | NOT FOUND / error
OK    | cf-knex | 0.3.2 | Knex.js for Cloudflare Workers - TiDB Serverless,
                           MySQL, Postgres, D1 and Turso, direct or via Hyperdrive
```

**`@tundralibs/drivers` is not published.** It cannot be installed, so it cannot be used.

`cf-knex` exists but is the wrong tool here:

- **v0.3.2** — effectively unmaintained; single-digit dependents.
- Knex is a **large** dependency (query builder + dialects). On Workers the free tier gives
  **10 ms CPU/request**; a fat query builder plus 6 dialect drivers blows past that on cold requests.
- Knex abstracts SQL *generation*, but we need to abstract **placeholder syntax** (`?` → `$1`),
  **boolean handling** (`1/0` vs `TRUE/FALSE`), **`RETURNING`**, and **upsert** — and do it
  explicitly so migrations are reviewable.
- It gives no answer for D1's native binding, nor for Neon over WebSocket.

**Decision: hand-roll the adapter.** Phase 3 asks for exactly this anyway —
`connect() / query() / migrate() / healthCheck()`. We implement it directly over three thin,
already-audited drivers. Result: ~250 lines we fully control, a much smaller bundle, and
predictable CPU cost.

---

## 4. 🚩 Blocker B — Next.js on Workers Has No Cron

An uptime monitor's **entire product is a scheduled handler**. This is the pivotal constraint.

From OpenNext's official docs (Custom Worker page):

> "The worker generated by the Cloudflare adapter **only exports a fetch handler**. Sometimes your
> application needs to expose another type of handler (i.e. **a scheduled handler**)… This can be
> achieved by **creating a custom worker**."

So with Next.js + `@opennextjs/cloudflare` (v1.20.9), cron *is* possible but only like this:

```ts
// @ts-ignore `.open-next/worker.ts` is generated at build time
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) { /* run checks */ },
} satisfies ExportedHandler<CloudflareEnv>;

// must also re-export, or DO-backed cache/queue breaks:
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
```

Costs of that path:
- We import a **generated build artifact**. Its shape is not part of a semver'd public API, so
  OpenNext upgrades can silently break the deploy. There is no `scheduled()` first-class support.
- We must remember the `DOQueueHandler`/`DOShardedTagCache` re-export or R2 incremental cache
  breaks — a failure mode that shows up at runtime, not build time.
- Next.js middleware + RSC render burns a large slice of the **10 ms/request** CPU budget.
- Much slower cold starts; far bigger bundle.

### Recommendation: **Hono + React (Vite)**

Hono exports `scheduled()` as a first-class, documented primitive. That plus the free-tier CPU
budget is decisive.

| | Next.js + OpenNext | **Hono + React (Vite)** |
|---|---|---|
| Cron `scheduled()` | custom wrapper on generated artifact | ✅ native `export default { fetch, scheduled }` |
| Server bundle | ~1 MB+ | ~120 KB (Hono is ~14 KB gz) |
| Cold start | slow | ✅ near-instant |
| CPU / req (10 ms free cap) | heavy | ✅ light |
| Zod validation | `zod` in route handlers | ✅ `@hono/zod-validator` middleware |
| Security headers | `middleware.ts` | ✅ `secureHeaders()` built in |
| Rate limiting | manual | ✅ Workers RL binding + `hono-rate-limiter` |
| Static assets | `.open-next/assets` | ✅ `dist/` |
| SSR / RSC | ✅ | ✖ SPA (mitigated below) |
| Upgrade risk | OpenNext-coupled | low |

**What we lose, and how we compensate.** No SSR/RSC → public status pages are client-rendered, which
hurts SEO/first-paint. Mitigation: the API returns a fully-formed status payload and the page
renders from a single fetch with a skeleton + `<meta>`/OG tags injected client-side. Status pages
are almost always shared as links (Slack/email), not crawled, so the real-world cost is small —
and it keeps the Worker inside free tier. The dashboard is authenticated and single-user-ish, so SPA
is a better fit anyway.

**This is a deliberate deviation from your "Next.js App Router preferred" instruction.** Because you
asked to confirm per phase, I'm flagging it now rather than after writing 60 files.

---

## 5. Multi-Database Reality: 6 Providers → 3 Dialects

The six requested providers collapse onto **two SQL dialects** and **three transports**.

| Requested provider | Dialect | Transport in Worker | Library |
|---|---|---|---|
| Cloudflare D1 | SQLite | native binding | *none* (built-in) |
| Turso | SQLite | HTTPS | `@libsql/client` |
| SQLite (local/Docker) | SQLite | in-process file | `better-sqlite3` |
| Neon | Postgres | WebSocket (HTTP) | `@neondatabase/serverless` |
| Supabase | Postgres | HTTPS (Supavisor / pooler) | `postgres` |
| PostgreSQL (Hyperdrive) | Postgres | Hyperdrive binding | `postgres` |

### 5.1 Portable-SQL rules (these are what make one schema work everywhere)

The original schema is **D1-locked**. A shared schema must avoid:

| ❌ Not portable | ✅ Portable equivalent |
|---|---|
| `datetime('now')` | app-generated ISO-8601 UTC string, or `DEFAULT (CURRENT_TIMESTAMP)` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `TEXT` UUID PK generated in app |
| `INSERT OR REPLACE INTO` | `INSERT … ON CONFLICT DO UPDATE` (works on **both** SQLite ≥3.24 and PG) |
| `active INTEGER 0/1` | `active BOOLEAN`; adapter maps `?`→`$1` **and** `0/1`→`false/true` |
| `?` placeholders | adapter rewrites to `$1..$n` for Postgres |
| `AUTOINCREMENT` on `checks.id` | `BIGINT` generated in app from `Date.now()`+random, or PG `GENERATED … AS IDENTITY` — we use app-side UUID to stay identical |
| `GROUP_CONCAT` | `string_agg` is PG-only → avoid, aggregate in JS |

`ON CONFLICT DO UPDATE`, `CHECK`, `FOREIGN KEY`, `TEXT`, `INTEGER`, `REAL`, `UNIQUE` and
`CREATE INDEX IF NOT EXISTS` are all valid on **both** engines. That overlap is what makes a single
migration set viable.

### 5.2 Adapter contract

```ts
interface DatabaseAdapter {
  readonly dialect: 'sqlite' | 'postgres';
  readonly provider: DBProvider;
  connect(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; meta: Meta }>;
  execute(sql: string, params?: unknown[]): Promise<Meta>;
  batch(statements: Stmt[]): Promise<Meta[]>;      // transactional batch
  transaction<T>(fn: (tx) => Promise<T>): Promise<T>;
  migrate(): Promise<MigrationResult>;              // auto-run on first request
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; version?: string }>;
  close(): Promise<void>;
}
```

Selected purely by env: `DB_PROVIDER = d1 | turso | supabase | neon | hyperdrive | sqlite`.
Defaults to `d1`. **No code change to switch DB** — the constraint "no vendor lock-in" holds.

### 5.3 Auto-migration

Pingflare uses `wrangler d1 migrations apply` (D1-only, CLI-only). We instead do:

1. `migrations/*.sql` are **embedded** into the Worker bundle at build time (no R2 fetch, no cold-start cost).
2. A `schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT)` table tracks applied versions.
3. On first request per database, `migrate()` runs inside a `ctx.waitUntil()`-friendly path, guarded by
   a module-scoped `Promise` so concurrent cold starts don't double-apply.
4. Every statement is `IF NOT EXISTS`, so it's idempotent and safe to re-run.
5. CLI also exposes `pnpm db:migrate` for manual runs.

This satisfies "auto-run migrations based on selected provider on first deploy" for **all six**
providers, not just D1.

---

## 6. Proposed Unified Architecture

### 6.1 One repo, one Worker

```
┌──────────────────────── ONE Cloudflare Worker ────────────────────────┐
│                                                                       │
│  Browser ──fetch──▶ Hono app                                          │
│                      ├─ secureHeaders (CSP/HSTS/XFO/…)                 │
│                      ├─ cors            (env allowlist)                │
│                      ├─ rateLimit       (Workers RL binding)          │
│                      ├─ /api/*         (Zod-validated handlers)       │
│                      ├─ /admin/*       (Basic/TOTP + IP allowlist)    │
│                      ├─ DatabaseAdapter ─┬─▶ D1        (SQLite)        │
│                      │                    ├─▶ libSQL    (SQLite)        │
│                      │                    ├─▶ Neon      (PG/WS)        │
│                      │                    ├─▶ Supabase  (PG/HTTPS)     │
│                      │                    └─▶ Hyperdrive(PG)           │
│                      └─ health-check engine (SSRF-guarded fetch)      │
│                                                                       │
│  Cron */1min ──▶ exported scheduled() ─┬─▶ staggered monitor sweep  │
│                      │                  ├─▶ daily_status aggregate     │
│                      │                  └─▶ notifications (dedup)      │
│                                                                       │
│  Static Assets ──▶ dist/ (React SPA, ~90 KB gz)                        │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.2 Repo layout

```
/
├─ src/
│  ├─ worker.ts                 # Hono app + { fetch, scheduled }
│  ├─ app/                      # React SPA
│  │  ├─ main.tsx  router.tsx
│  │  ├─ pages/  (Dashboard, StatusPage, Admin, Login, Onboarding)
│  │  ├─ components/ (UptimeBar, LatencyChart, EdgeMap, MonitorCard, …)
│  │  ├─ hooks/  useLiveData.ts, useMonitors.ts
│  │  └─ styles/ tokens.css
│  ├─ server/
│  │  ├─ db/  adapter.ts types.ts dialect.ts migrate.ts
│  │  │     providers/{d1,turso,neon,supabase,hyperdrive,sqlite}.ts
│  │  ├─ routes/ monitors.ts incidents.ts status.ts alerts.ts auth.ts
│  │  ├─ middleware/ security.ts auth.ts ratelimit.ts cors.ts
│  │  ├─ checkers/ engine.ts dsl.ts ssrf.ts
│  │  ├─ notifications/ webhook.ts slack.ts discord.ts
│  │  └─ auth/ pbkdf2.ts totp.ts session.ts
│  ├─ shared/  schemas.ts (Zod)  types.ts  time.ts
├─ migrations/  0001_init.sql …   # portable SQL, both dialects
├─ scripts/  migrate.ts  seed.ts
├─ setup.sh  setup.ps1  wrangler.toml.example
├─ docker/  Dockerfile  docker-compose.yml
└─ docs/  README DEPLOYMENT CONFIGURATION SECURITY API
```

Frontend and backend **coexist in one repo, one bundle, one Worker** — exactly as required.

### 6.3 Schema (portable, superset of original + fixes)

`monitors` (url/method/headers/body/kind/interval/timeout/retries/latency_threshold/degraded_threshold/
active/group_id), `checks` (+ `colo`, `ip`, `region`), `daily_status`, `monitor_groups`,
`incidents`, `incident_updates`, `notification_channels`, `monitor_notifications`,
`alert_states` (dedup + downtime-threshold tracking), `users`, `sessions`, `totp_secrets`,
`schema_migrations`, `app_settings`.

`monitor_groups` gains `slug` + `theme` so multiple **branded public status pages** are possible
(original had slug but only lightly used it).

---

## 7. Free-Tier Budget (the real constraint nobody designs around)

Cloudflare free: **100 000 req/day**, **10 ms CPU/request**, **Cron ≥ 1 min**, **≤ 50 subrequests
per invocation**, D1 5 M rows read/day.

Pingflare's README admits ~25 monitors, because every check costs a subrequest. Design decisions:

| Risk | Mitigation |
|---|---|
| 1 subrequest/check × N monitors > 50 | **Staggered batches** across minutes; `CHECKS_PER_RUN` cap (default 20) |
| Cron CPU ceiling | `ctx.waitUntil()`, `Promise.allSettled`, hard per-check timeout |
| D1 row reads | `daily_status` aggregates; 7-day raw retention; 1 covering index per hot query |
| `checks` write volume | batched multi-row `INSERT` (1 statement ≠ N) |
| Cron per-minute = 43 200/day worker invocations | one invocation does many checks; cheap |
| Frontend bandwidth | code-split Leaflet & Recharts via `React.lazy`; skeleton UI, no layout shift |

---

## 8. Security Posture (Phase 4 preview)

- **Passwords** — PBKDF2-SHA256, 210 000 iters, per-user 16-byte salt, constant-time verify.
- **Sessions** — 32-byte random id, `HttpOnly; Secure; SameSite=Lax; Path=/`, sliding 7-day expiry,
  hashed at rest in DB so a DB leak doesn't yield live sessions.
- **TOTP 2FA** — RFC 6238, HMAC-SHA1/6-digit/30 s, ±1 window, replay-safe via last-used counter.
- **SSRF guard** — scheme allowlist (`http`/`https`), reject credentials in URL, resolve host and
  block loopback/link-local/RFC1918/ULA/metadata `169.254.169.254`, cap redirects to 3, cap body to
  1 MB, strip `Authorization` on cross-host redirect.
- **Rate limits** — Workers Rate Limiting binding (edge-accurate) + Hono in-memory fallback for
  non-Workers runtimes (Docker). Tighter buckets on `/api/auth/*`.
- **Headers** — CSP with nonce, `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (deny camera/mic/geolocation).
- **Secrets** — only ever `wrangler secret put` / `.dev.vars`; `.env` gitignored; CI greps the repo
  to fail on committed secrets.
- **IP allowlist** — CIDR-aware `ADMIN_IP_ALLOWLIST` guarding `/admin/*` and mutating APIs.
- **Audit log** — `audit_log` table for auth events and destructive actions.

---

## 9. Proposed Build Order

| Phase | Content |
|---|---|
| 1 | ✅ This analysis + architecture (awaiting your sign-off) |
| 2 | Hono + React skeleton, security middleware, auth (PBKDF2 + TOTP), core CRUD APIs |
| 3 | `DatabaseAdapter` + 6 providers + portable migrations + auto-migrate |
| 4 | Check engine (SSRF-guarded DSL), cron `scheduled()`, notifications, alert dedup |
| 5 | UI — dark dashboard, Leaflet edge map, Recharts live charts, status pages, admin |
| 6 | `setup.sh` / `setup.ps1`, `wrangler.toml.example`, Docker |
| 7 | Docs: README, DEPLOYMENT, CONFIGURATION, SECURITY, API (Hinglish) |

---

## 10. Decisions Needing Your Confirmation

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Hono + React (Vite)** instead of Next.js App Router | ✅ Accept — cron is native, CPU/cold-start fit the free tier. Next.js needs a wrapper around a generated artifact. |
| D2 | **Hand-rolled adapter**, not `cf-knex`/`@tundralibs/drivers` | ✅ Accept — the named package does not exist; `cf-knex` is 0.3.2 and heavy |
| D3 | **SPA frontend** (no SSR) | ✅ Accept — status pages are link-shared; mitigated with prerendered shell + OG tags |
| D4 | Package manager | **pnpm** (you have it; also lockfile-deterministic for CI). Pingflare used bun. |
| D5 | Raw SQL (no ORM) | ✅ Accept — needed for dialect portability; migrations stay reviewable |
| D6 | UI kit | **Tailwind 4 + custom tokens**, Recharts, Leaflet — no component library lock-in |

---

_Last updated: Phase 1 complete. Reference clone: `_reference_pingflare/`._