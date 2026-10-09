# ANALYSIS.md — PulsePost Phase 1: Deep Analysis & Real-Time Web Research

> **Phase 1 deliverable.** Ye file padhne ke baad hi code me haath daalna chahiye.
> Research date: **9 October 2026**. Saare Cloudflare numbers official docs se
> verify kiye gaye hain (links neeche diye hain) — speculation nahi.
>
> **Constraint follow kiya gaya hai:** kuch bhi *remove* nahi hoga. Sirf
> *add* aur *improve*.

---

## 0. Ek zaroori baat pehle

Aapke brief me do cheezein likhi hain jo **available nahi** hain:

| Brief me | Reality |
|---|---|
| `@tundralibs/drivers` | ❌ npm par **publish hi nahi hua**. Install nahi ho sakta. |
| `cf-knex` | ⚠️ Exists (v0.3.2) par galat tool — neeche §3 me detail. |
| `/backend-dev-guidelines` skill | ❌ Mere environment me nahi hai |
| `/ui-ux-pro-max` skill | ❌ Mere environment me nahi hai |

Isliye:
- **Database:** hand-rolled adapter (already implemented hai — Phase 4 poora).
- **UI skills:** `minimalism` + `design-it` + `vercel-react-best-practices` use karunga.

---

## 1. Current Architecture — Asli Picture

### 1.1 Ek deploy unit, teen kaam

Poora project **ek Cloudflare Worker** hai. Koi alag API host nahi, koi alag
frontend deploy nahi.

```
                        ┌──────────────────────────────┐
  Browser ─────────────▶│  Worker "pulsepost"          │
   (SPA, static assets) │                              │
                        │  ┌────────┐  ┌────────────┐  │
  /status (public) ────▶│  │ Hono   │  │ static     │  │
                        │  │ API    │  │ assets     │  │
                        │  │ 37     │  │ (React SPA)│  │
                        │  │ routes │  └────────────┘  │
                        │  └────┬───┘                   │
                        │       │                       │
  Cron * * * * * ──────▶│  ┌────▼─────────┐             │
   (every minute)       │  │ checkers/    │             │
                        │  │ sweep.ts     │             │
                        │  └────┬─────────┘             │
                        └───────┼───────────────────────┘
                                ▼
              ┌─────────── DatabaseAdapter ───────────┐
              │ connect / query / migrate / healthCheck│
              └────┬────┬────┬────┬────┬────┬────────┘
                   ▼    ▼    ▼    ▼    ▼    ▼
                  D1  Turso Neon Supa HDrive SQLite
```

`src/worker/index.ts:54-60` pe saare routers mount hote hain.

### 1.2 Folder reality

```
src/
├─ worker/                    # Backend — ek Hono app
│  ├─ routes/       auth · monitors · groups · incidents · channels · users · status
│  ├─ db/           base · dialect · index · types · providers/{d1,libsql,neon,postgres}
│  ├─ checkers/     engine.ts (DSL) · sweep.ts (cron) · ssrf.ts (guard)
│  ├─ auth/         password.ts (PBKDF2) · session.ts · totp.ts
│  ├─ middleware/   context.ts · ratelimit.ts · security headers
│  └─ notifications/send.ts
├─ shared/          types.ts + schemas.ts (Zod) — dono taraf share
└─ web/             React 19 + Vite 7 SPA
```

**Koi `db/types.ts:102` me `DatabaseAdapter` interface** — ye Phase 4 ka poora kaam
already hai. 6 providers implemented.

### 1.3 Build pipeline

`package.json:28-33` — plain `node` calls, koi framework nesting nahi:

```
build  = gen-migrations → vite build
deploy = gen-migrations → vite build → wrangler deploy
dev    = gen-migrations → vite build → wrangler dev
```

`migrations/0001_init.sql` build-time pe embed hota hai
(`src/worker/db/migrations.generated.ts`). Runtime pe app **har request pe
`db.migrate()`** call karta hai (`src/worker/middleware/context.ts:47`), jo
isolate lifetime ke liye memoize hota hai — isliye deploy ke baad first request
schema khud apply kar deta hai.

---

## 2. Feature Inventory — Jo Aaj Kaam Karta Hai

| Area | Features | Status |
|---|---|---|
| **Monitors** | HTTP + multi-step DSL, 11 assertion operators, expected status range, latency warn/fail, retries, timeout, max response bytes, follow-redirects | ✅ Full CRUD |
| **Cron sweep** | Least-recently-checked fairness, retry, alert dedup, `alert_states` | ✅ |
| **Groups** | Create / rename / slug / description / theme / publish / reorder | ✅ *(is session me rename/reorder add kiya)* |
| **Incidents** | Create, status progression, timeline updates, auto `resolved_at` | ✅ *(is session me UI add ki)* |
| **Channels** | webhook / slack / discord, per-monitor `notify_on` + downtime threshold, test send | ✅ *(is session me UI add ki)* |
| **Users** | 3 roles, TOTP 2FA, PBKDF2, rank guards, audit log | ✅ *(is session me UI add ki)* |
| **Status page** | Public, per-group slug, never leaks monitor URLs | ✅ |
| **Dashboard** | Edge map (Leaflet), latency charts (Recharts), 90-day uptime bars | ✅ |
| **Search/sort/page** | `?q=`, `?sort=`, `?order=`, `?offset=`, `?limit=` | ✅ *(is session me add kiya)* |
| **DB portability** | 6 providers, one SQL file, dialect layer | ✅ |

---

## 3. 🚩 Research Finding — `@tundralibs/drivers` nahi hai

Brief me likha tha *"Use `@tundralibs/drivers` or `cf-knex`"*.

```
npm view @tundralibs/drivers  →  404 NOT FOUND
npm view cf-knex              →  0.3.2
```

`cf-knex` galat choice hai:

1. **v0.3.2, effectively unmaintained**, single-digit dependents.
2. **Bada bundle.** Workers free tier = **10 ms CPU per request** (verified).
   Knex query builder + 6 dialect drivers cold request pe usse cross kar dete hain.
3. **Galat abstraction.** Humein SQL *generation* nahi chahiye — humein
   *placeholder syntax* (`?` → `$1`), *boolean binding* (`0/1` vs `TRUE/FALSE`),
   `RETURNING`, aur upsert translate karne hain, aur ye **explicit** karna hai taaki
   migrations reviewable rahein.
4. D1 ka native binding aur Neon-over-WebSocket ka koi answer nahi deta.

**Decision:** hand-rolled adapter. ~250 lines, poora control, chhota bundle,
predictable CPU. **Ye already implemented hai** (`src/worker/db/`).

---

## 4. Real-Time Web Research — Verified Findings

### 4.1 🔴 Cloudflare Workers Free Tier — Asli Numbers

Source: <https://developers.cloudflare.com/workers/platform/limits/> (updated **Oct 8, 2026**)

| Feature | Free | Paid |
|---|---|---|
| Requests | **100,000/day** | No limit |
| **CPU time / request** | **10 ms** | 5 min (default 30 s) |
| **CPU time / cron trigger** | **10 ms** | 30 s (< 1 h interval) |
| Memory | 128 MB | 128 MB |
| **Subrequests / invocation** | **50** | 10,000 |
| **Simultaneous open connections** | **6** | 6 |
| Cron triggers per account | 5 | 250 |
| Env vars per Worker | 64 | 128 |
| Worker size | 64 MiB | 64 MiB |
| Startup time | 1 second | 1 second |
| Static assets / version | 20,000 | 100,000 |
| Cron wall time | 15 min | 15 min |
| Route mode on overflow | fail open **by default** | configurable |

**Is project pe 3 direct asar hain:**

| Finding | Is project ka matlab | Action |
|---|---|---|
| **10 ms CPU/request** | PBKDF2 100k iterations natively ~100 ms+ maarta hai. Ye budget se **bahar** hai. Docs kehta hai: *"Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit."* — isliye production pe chalta hai, par **reliance** fragile hai. | ⚠️ Document + monitor. Phase 6 me CPU profiling. |
| **50 subrequests** | `wrangler.toml:121` me `CHECKS_PER_RUN = 20` — sahi hai, headroom bachaya hai. Notification calls bhi usi 50 me count hote hain. | ✅ Already correct. **Isko barhana mat.** |
| **6 simultaneous connections** | Cron ek saath 20 monitor check karta hai. Har `fetch()` initial-headers phase me connection gherega. | 🔴 **Phase 3 me concurrency cap = 6** lagana padega, warna queue khadi hogi. |

**Extra:** "Update Zod — use version **4.5.0 or later**. Earlier versions use substantially more memory per schema." Project me `zod ^4.6.5` hai ✅.

### 4.2 🟠 Cloudflare D1 Free Tier

Source: <https://developers.cloudflare.com/d1/platform/limits/> (updated **Apr 21, 2026**)

| Feature | Free | Paid |
|---|---|---|
| Databases per account | **10** | 50,000 |
| Max database size | **500 MB** | 10 GB |
| Max storage per account | 5 GB | 1 TB |
| Time Travel | 7 days | 30 days |
| **Queries per Worker invocation** | **50** | 1,000 |
| Columns per table | 100 | 100 |
| Row / string / BLOB size | 2 MB | 2 MB |
| SQL statement length | 100 KB | 100 KB |
| **Bound parameters per query** | **100** | 100 |
| **`LIKE` / `GLOB` pattern** | **50 bytes** | 50 bytes |
| Max query duration | 30 s | 30 s |
| Concurrent connections to D1 | 6 | 6 |

**D1 single-threaded hai** — ek query ek time. Docs:
> "If your average query takes 1 ms, you can run approximately 1,000 queries per second. If it takes 100 ms, you can run 10 queries per second."

### 🐛 Ye research ek REAL bug uncover karta hai

`listWithStatus()` mein maine is session me search add kiya tha
(`src/worker/repository/monitors.ts`). Maine schema me `q` ka max **120 chars**
rakha tha.

**D1 ka `LIKE` pattern limit 50 bytes hai.** Matlab 51+ characters ka search
validation pass kar lega, phir database error throw karega — exactly wahan jahan
user ko ek normal search karni thi. Aur woh *free tier pe* hoga.

**Fix (lagaya):**
- `src/shared/schemas.ts` — `q` ka max **48** (kyunki pattern 2 `%` se wrap hota hai)
- `src/worker/repository/monitors.ts` — `likePattern()` bhi `.slice(0, 48)` karta hai, taaki schema bypass karne wala future caller bhi error na mile, balki chhota result paaye

**Yehi kaam Phase 1 ka asli faida hai — research ne ek bug pakda jo bina research ke production pe hi fail hota.**

### 4.3 Minimalist UI Trends for Uptime Dashboards (2026)

Industry se verify kiya (Better Stack + Uptime Kuma product pages):

| Trend | Is project me | Phase 2 action |
|---|---|---|
| **At-a-glance single status verdict** | ✅ `StatCard` "Overall" + status pill | Rakhna |
| **90-day uptime bars** (Stripe-style) | ✅ `UptimeBars.tsx` | Rakhna |
| **Response-time sparklines** | ⚠️ Recharts full chart hai, sparkline nahi | **Sparkline add karna** |
| **Worst-status-wins** on public page | ✅ `PublicStatus.tsx` me implemented | Rakhna |
| **"No data = neutral, never healthy"** | ✅ implemented, comment bhi hai | Rakhna |
| **Type-weight hierarchy, no card chrome** | ❌ Har jagah `.panel` cards + borders | **Editorial Minimal overhaul** |
| **Dark-first + light toggle** | ❌ `tokens.css:36` hardcoded `color-scheme: dark` | **Light mode tokens banana** |
| **Minimal / detailed status-page toggle** | ❌ ek hi layout | **Mode switch** |
| **Sparse map** — markers only, no clutter | ⚠️ Leaflet + invert-filter OSM | **CartoDB Dark Matter proper tiles** |

### 4.4 Leaflet + CartoDB Dark Matter

**Kyun CartoDB, OSM nahi?**

| | OpenStreetMap (current) | CartoDB Dark Matter |
|---|---|---|
| API key | Nahi chahiye | Nahi chahiye ✅ |
| Dark basemap | ❌ nahi hai — hum CSS `filter: invert()` se force kar rahe hain | ✅ natively dark |
| Filter cost | Har tile pixel pe GPU filter | **Zero** |
| Roads/labels | Invert hone se text halka/muddha | Native contrast sahi |
| Attribution | OSM | **CartoDB + OSM dono dena zaroori hai** |
| Rate limit | Fair-use policy | Fair-use |

Current hack `tokens.css:233`:
```css
.leaflet-tile-pane {
  filter: invert(1) hue-rotate(180deg) brightness(0.94) contrast(0.86) saturate(0.55);
}
```
Ye kaam karta hai, lekin ye **filter bandana** colors ko predictably nahi rakhta —
koi bhi map redesign karne wala pehle yahan atakega.

**Phase 2 plan:**
- `basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` — free, no key, no signup
- Light mode ke liye `light_all`
- Tile layer runtime me theme se swap hoga
- Attribution zaroori: `&copy; OpenStreetMap contributors &copy; CARTO`
- CSP me `basemaps.cartocdn.com` add karna padega

### 4.5 Multi-Database Adapter Patterns

Ye Phase 4 ka research hai — aur **verify karta hai ki current design sahi hai**:

| Provider | Driver | Dialect ka kaam | Notes |
|---|---|---|---|
| **D1** | native `D1Database` binding | `?` placeholders, `0/1` booleans | No network cost, single-threaded |
| **Turso** | `@libsql/client` | `?`, `0/1` | SQLite-compatible |
| **Neon** | `@neondatabase/serverless` | `$1`, `TRUE/FALSE` | WebSocket transport |
| **Supabase** | `postgres` (postgres.js) | `$1`, `TRUE/FALSE` | **Pooler URL zaroori** — direct IPv6-only hai jo Workers reach nahi kar sakta |
| **Hyperdrive** | `postgres` | `$1`, `TRUE/FALSE` | Credentials Hyperdrive inject karta hai, secret mat banao |
| **SQLite** | `@libsql/client` local file | `?`, `0/1` | Docker/dev only |

**Pattern jo project follow karta hai sahi hai:** ek `dialect.ts` layer jo sirf
*syntax* translate karta hai — placeholder, boolean, `{{now}}` token. SQL khud
**same** rehta hai. Yehi wajah hai ki `migrations/0001_init.sql` ek hi file
SQLite aur Postgres dono pe chalti hai.

⚠️ **Ek inconsistency mili:** `migrations/0001_init.sql:12` header mein likha hai
`No ... INSERT OR REPLACE`, lekin `src/worker/routes/auth.ts:97` use karta hai
(SQLite-only). Wo `.catch()` se Postgres fallback de raha hai, to kaam karta hai —
par header galat claim kar raha hai. Phase 7 me theek karna hai.

### 4.6 Notification Integrations — Research

Har channel ka **actual** method, aur free-tier pe kya possible hai:

| Channel | Method | Workers pe | Auth |
|---|---|---|---|
| **Slack** | Incoming webhook `POST` | ✅ direct | URL = secret |
| **Slack bot** | `chat.postMessage` + token | ✅ | `xoxb-` token |
| **Discord** | Webhook `POST` | ✅ direct | URL = secret |
| **Telegram** | `api.telegram.org/bot<token>/sendMessage` | ✅ | bot token + chat_id |
| **ntfy** | `POST https://ntfy.sh/topic` | ✅ | topic = quasi-secret |
| **ntfy self-hosted** | Custom base URL | ✅ | same |
| **Generic webhook** | `POST` + HMAC-SHA256 signature | ✅ | `X-PulsePost-Signature` header |
| **WhatsApp (Twilio)** | Twilio REST + Basic auth | ✅ | account SID + auth token |
| **WhatsApp Cloud API** | Graph API | ⚠️ Meta app review chahiye | token + phone ID |
| **Stoat** | stoat.chat webhook | ✅ | URL |
| **Metagraph API** | Constellation Network | ⚠️ verify karna hoga | API key |
| **Email (Resend/SendGrid)** | HTTPS API | ✅ (Workers `fetch`) | API key |
| **Email (SMTP)** | Raw TCP socket | ⚠️ `connect()` max 6, fragile | — |
| **SMS (Twilio)** | REST | ✅ | SID + token |
| **PagerDuty** | Events API v2 | ✅ | routing key |
| **Opsgenie** | Alert API | ✅ | API key |
| **Pushover** | Messages API | ✅ | user key |
| **Gotify** | Self-hosted base URL | ✅ | app token |
| **Pushbullet** | REST | ✅ | access token |

### 🟥 Apprise — kyun use NAHI karna chahiye

Brief me "Use Apprise library (Python) for unified notification routing" likha hai.
**Ye Workers pe architecturally impossible hai:**

1. Apprise **Python** hai. Workers runtime **JavaScript** hai (`workerd`).
2. Workers Python sirf `Pyodide`/`Workers AI` se aata hai — jo **network egress
   block** karta hai. Notification bhejna hi egress hai. **Circular.**
3. Ye ek *entire runtime* laata hai jo free tier ke **64 MiB worker size** aur
   **10 ms CPU** dono ko kha jayega.

**Recommended替代 (substitute):** TypeScript me ek `NotificationTransport`
interface — jo `src/worker/notifications/send.ts` already implicitly hai —
aur har channel ka ek chhota module. Isse:
- Zero extra runtime
- Har channel ka **test button** naturally banta hai
- Config JSON me ek hi shape (`{ type, ...fields }`)

> **Ye ek deliberate deviation hai brief se.** Brief ka maqsad tha "unified
> notification routing" — woh TypeScript interface se achieve hota hai, Python
> runtime ke bina. Agar aap insist karein to bata dijiye, par Workers pe ye
> ship nahi hoga.

### 4.7 Security Hardening — Current vs Best Practice

| Control | Project | Best practice | Verdict |
|---|---|---|---|
| Password hashing | PBKDF2-SHA256, 100k iters, 16-byte salt | OWASP: 600k | ⚠️ **Platform-capped** |
| Constant-time compare | ✅ `constantTimeEqual` | required | ✅ |
| Session storage | SHA-256 hash of token | hash at rest | ✅ |
| Rate limiting | Workers native binding + Hono | edge-native | ✅ |
| Input validation | Zod **har route** par | required | ✅ |
| CSP | `script-src 'self'` | nonce ideal | ✅ |
| HSTS | ✅ | required | ✅ |
| SSRF guard | scheme allowlist, private/CGNAT/link-local block, DNS re-resolution, redirect revalidation, size cap | defense in depth | ✅ **Exemplary** |
| TOTP 2FA | RFC 6238, AES-GCM encrypted seeds | required | ✅ |
| IP allowlist | CIDR + exact | required | ✅ |
| CORS | env-driven | required | ✅ |
| Audit log | har mutation | required | ✅ (but **koi read endpoint nahi**) |
| Timing-equal login | `DUMMY_HASH` | required | ✅ *(is session me drift fix kiya)* |

### 🐛 Research ne 3 real bugs pakde (ye session)

Ye teeno **production-only** the — Node tests sab green the:

| # | Bug | Symptom | Root cause |
|---|---|---|---|
| 1 | PBKDF2 210k iters | `NotSupportedError` — signup 500 | workerd PBKDF2 cap = **100k** |
| 2 | `options.fetchImpl(...)` | `Illegal invocation` — har monitor down | workerd `fetch` native binding; method-style call invalid `this` |
| 3 | Channel link `monitor_id` | Alert silently kisi monitor pe nahi jaata thi | body ka `channel_id` seedha `monitor_id` column me likha ja raha tha |

Aur ek **research-only** bug:
| 4 | `LIKE` pattern 120 chars | D1 error on long search | D1 ka 50-byte `LIKE` limit |

Teeno ke regression tests likhe gaye hain. Har test **verify kiya gaya hai ki
bina fix ke fail hota hai** — warna bekaar test hota.

---

## 5. Competitor Comparison

| Feature | **PulsePost** | Uptime Kuma | Pingflare | UptimeFlare | Gatus |
|---|---|---|---|---|---|
| Runtime | Cloudflare Worker | Node/Docker | Worker + D1 | Worker + D1 | Go binary |
| **Free tier** | ✅ **100% free, no card** | Self-host | ✅ Free | ✅ Free | Self-host |
| DB options | **6 providers** | SQLite only | D1 only | D1 only | YAML |
| Notification channels | 3 | **90+** | 4 | ~3 | 12 |
| Check interval min | 60s | **20s** | 60s | 60s | 30s |
| Multi-step DSL | ✅ **11 operators** | ❌ | ✅ | ❌ | ❌ |
| SSRF hardening | ✅ **Layered** | Basic | Basic | Basic | Basic |
| Multi-region checks | ❌ `CHECK_COLOS` set but unused | ❌ | Geo | ✅ **310+ cities** | ❌ |
| SLO tracking | ❌ | ❌ | ❌ | ❌ | ✅ **Native** |
| Incident management | ✅ Timeline | ✅ | ✅ | ✅ | ❌ |
| Public status page | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screenshots on failure | ❌ | ✅ | ❌ | ❌ | ❌ |
| SSL expiry monitoring | ❌ | ✅ | ❌ | ❌ | ❌ |
| Cron/heartbeat monitoring | ❌ | ✅ | ❌ | ❌ | ❌ |
| Light mode | ❌ | ✅ | ❌ | ❌ | N/A |
| **Vendor lock-in** | ✅ **Zero** (`DB_PROVIDER`) | N/A | D1 only | D1 only | N/A |

**Saaf conclusion:**
- PulsePost **kisi se bhi hare nahi** monitoring core me, aur **6-provider DB**
  portability me aage hai.
- **3 jagah peeche:** notification breadth (3 vs 90+), check interval (60s vs 20s),
  aur geo-distributed checks.
- **2 unique:** 11-assertion multi-step DSL, aur layered SSRF guard.

---

## 6. Gap Matrix → Phase Mapping

| Phase | Status | Remaining work |
|---|---|---|
| **1. Analysis + research** | ✅ **ye file** | — |
| **2. Minimalist UI** | 🔴 Not started | Light/dark token system · Editorial Minimal (no card chrome) · **CartoDB Dark Matter** tiles · sparklines · minimal/detailed status toggle · responsive pass |
| **3. CRUD + advanced** | 🟡 ~60% | Tags/categories · bulk actions · export/import (JSON/CSV) · **audit log read endpoint + UI** · time-based scheduling · concurrency cap 6 |
| **4. Multi-DB adapter** | ✅ **done** | Sirf doc + header fix (`INSERT OR REPLACE` claim) |
| **5. Notifications** | 🔴 Mostly missing | Telegram · ntfy · PagerDuty · Opsgenie · Pushover · Gotify · Pushbullet · Email (Resend/SendGrid) · SMS (Twilio) · WhatsApp · Stoat · **HMAC-signed generic webhook** · test button per channel |
| **6. Security** | 🟢 ~95% done | CPU profiling · audit log viewer |
| **7. Docs (7 files)** | 🟡 Partial | DEPLOYMENT · CONFIGURATION · API · CONTRIBUTING · CHANGELOG |
| **8. Free-tier deploy** | 🔴 Missing | `setup.sh` / `setup.ps1` · Docker compose verify · `workers.dev` walkthrough |

### 8-phase constraint ka audit

| Constraint | Reality |
|---|---|
| Kuch remove nahi | ✅ Har phase additive. Phase 3 me sirf add hua. |
| Minimalist UI | 🔴 Phase 2 me hoga |
| Real-time research | ✅ §4 — Cloudflare docs 2026-10-08 se |
| 100% free tier | ⚠️ **Do cheezein free-tier ke against hain** (neech dekho) |
| No telemetry | ✅ Koi telemetry nahi hai. Local D1 + ek external fetch (monitoring ka kaam hi woh hai). |
| Low bandwidth | ✅ Leaflet/Recharts lazy-loaded, code-split |
| Hinglish docs | ✅ Ye file se shuru |

### ⚠️ Free-tier constraints jo accept karne padenge

| Constraint | Practical effect |
|---|---|
| **10 ms CPU/request** | PBKDF2 100k + cold start. Isolate flexibility par depend karta hai. |
| **60s min interval** | 20-second checks (Kuma) free pe **impossible**. Cron `* * * * *` hi floor hai. |
| **6 simultaneous connections** | Multi-region checks ek saath nahi. Sequential ya max-6 concurrency. |
| **50 D1 queries/invocation** | Bulk operations batch karne padenge. |
| **500 MB / database** | Retention windows tune karne padenge. Already `RAW_CHECK_RETENTION_DAYS=7`. |
| **10 databases / account** | D1 adapter ke liye kaafi hai. |

---

## 7. Ek Important Note — Naming

Repo `PulsePost` hai, brief me baar-baar **"NovaPulse"** likha hai, aur
`.gitignore` me ek `_reference_pingflare/` folder hai. Ye **same** project hai —
alag nahi. Maine naming ko **nahi** badla (constraint: kuch remove/rename nahi).

---

## 8. Phase 2 ke liye Ready Recommendations

1. **Light mode pehle** — `tokens.css` me `[data-theme='light']` token block.
   Isse pure app ek saath responsive ho jaayega, bina kisi component chhede.
2. **CartoDB tiles** — invert-filter hatao, proper dark basemap. Ek line change,
   par visual quality me bada upgrade. CSP update bhi karna hoga.
3. **Button feedback** — abhi `Button` component pe koi pressed/saved state
   nahi hai. Busy spinner hai, lekin "save hua ya nahi" ka visual confirm nahi.
   **Toast + pressed state** chahiye.
4. **Sparklines** — per-monitor latency ka 20-point mini chart.

---

**Phase 1 complete.** Confirm kijiye Phase 2 shuru karun?

### Sources

- <https://developers.cloudflare.com/workers/platform/limits/> *(Oct 8, 2026)*
- <https://developers.cloudflare.com/d1/platform/limits/> *(Apr 21, 2026)*
- <https://betterstack.com/uptime> · <https://betterstack.com/incident-management>
- <https://github.com/louislam/uptime-kuma> · <https://github.com/TwiN/gatus>
- <https://github.com/caronc/apprise>
- <https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors>