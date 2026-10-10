# Configuration

PulsePost ka poora behaviour do jagah se control hota hai: `wrangler.toml` ke
`[vars]` (non-secret) aur Cloudflare secrets (sensitive).

---

## Non-secret config — `[vars]` in `wrangler.toml`

Ye file gitignored hai. Values edit karne ke baad `pnpm deploy` chalao.

### `DB_PROVIDER`

**Default:** `"d1"`

Kaunsa database adapter active karega. Isi ek line se lock-in khatam hoti hai.

| Value | Backend | Extra |
|---|---|---|
| `d1` | Cloudflare D1 | `wrangler d1 create` |
| `turso` | Turso / LibSQL | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| `neon` | Neon Postgres | `NEON_DATABASE_URL` |
| `supabase` | Supabase Postgres | `SUPABASE_DATABASE_URL` (pooler) |
| `hyperdrive` | Postgres via Hyperdrive | `wrangler hyperdrive create` |
| `sqlite` | Local SQLite file | `DATABASE_URL=file:./data/…` |

Adapter `src/worker/db/` me ek file per provider hai. Naya provider add karna ho
to `src/worker/db/types.ts` wala interface implement karo.

---

### `ENVIRONMENT`

**Default:** `"production"`

`"production"` ya `"development"`. Sirf logging verbosity aur kuch dev-only
guards isko padhte hain.

> **`ALLOW_PRIVATE_TARGETS` kabhi bhi `ENVIRONMENT` se infer nahi hota.**
> Private addresses monitor karna ho to wo alag flag se on karo.

---

### `APP_NAME`

**Default:** `"PulsePost"`

Slack/Discord payload me sender name, aur status page ka naam.

---

### `CORS_ORIGINS`

**Default:** `""` (koi extra origin allowed nahi)

Comma-separated origins jo browser se API call kar sakti hain.

```
CORS_ORIGINS = "https://status.example.com,https://dash.example.com"
```

Same-origin browser requests **hamesha** allowed hain — is list me apna khud ka
domain daalne ki zaroorat nahi. Isi liye default khali hai aur production me
khuli chhodna safe hai.

---

### `ADMIN_IP_ALLOWLIST`

**Default:** `""` (sab allowed)

Comma-separated IPs / CIDR ranges jo `/api/auth/*` tak pahunch sakte hain.

```
ADMIN_IP_ALLOWLIST = "203.0.113.7,198.51.100.0/24"
```

Khali = koi IP restriction nahi, aur Basic/TOTP auth phir bhi lagta hai. Ye
**extra layer** hai, authentication ki replacement nahi — password hi asli darwaza
hai.

---

### `AUTH_MODE`

**Default:** `"password"`

| Value | Behaviour |
|---|---|
| `password` | Database-backed PBKDF2 sessions. Normal choice |
| `basic` | HTTP Basic vs `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Docker ke liye |
| `totp` | Password login + **mandatory** TOTP second factor |

`basic` mode me `ADMIN_USERNAME` aur `ADMIN_PASSWORD` secrets set karne honge.

---

### `CHECK_COLOS`

**Default:** `""` (cron event receive karne wale colo se hi)

Comma-separated Cloudflare colo codes jahan se checks run karne hain:

```
CHECK_COLOS = "SFO,LHR,NRT,SYD"
```

Har colo ek alag edge location hai — isse pata chalta hai ki service **globally**
down hai ya kisi ek region se. Har colo per colo ek extra sweep invocation hai.

---

### `CHECKS_PER_RUN`

**Default:** `20`

Cron invocation me kitne monitors check karne hain.

**Ye number `CHECK_COLOS` se multiply hona chahiye.** 4 colos aur `CHECKS_PER_RUN = 20`
matlab 80 checks per invocation — jo 50 subrequest cap ke upar jaayega.

Workers free tier 50 subrequests deta hai. Har monitor check = 1 subrequest, plus
notification calls. Isliye headroom chhodna zaroori hai:

```
CHECK_COLOS=""              CHECKS_PER_RUN=20   →  20 checks   OK
CHECK_COLOS="SFO,LHR"       CHECKS_PER_RUN=20   →  40 checks   OK
CHECK_COLOS="SFO,LHR,NRT"  CHECKS_PER_RUN=20   →  60 checks   ✗ limit cross
```

3 colos chahiye to `CHECKS_PER_RUN = 12` rakho.

---

### Retention

| Var | Default | Matlab |
|---|---|---|
| `RAW_CHECK_RETENTION_DAYS` | `7` | Har individual check kitne din tak |
| `DAILY_STATUS_RETENTION_DAYS` | `365` | Daily rollup kitne din tak |

Raw checks 1440/min/monitor likhte hain — isiliye 7 din. Daily rollups uska
~1/1440 hota hai, isliye 365 din affordable hai. 90/365-day uptime bars rollups
se aati hain, raw table se nahi — isiliye chart load sasta rehta hai.

Zyada chahiye to badhao, cost badhegi:

| Storage | Rows per monitor per year |
|---|---|
| Raw (`RAW_CHECK_RETENTION_DAYS = 365`) | ~525,600 |
| Rollup (`DAILY_STATUS_RETENTION_DAYS = 365`) | 365 |

---

### `MAINTENANCE_HOUR_UTC`

**Default:** `0` (midnight UTC)

Daily aggregation aur cleanup kis UTC ghante me chale. Cron har minute chalta
rehta hai, lekin ye kaam **sirf is ghante me** hota hai — baaki 23 ghante
schedule sirf monitor checks karte hain.

---

### `ALLOW_PRIVATE_TARGETS`

**Default:** `false`

**Production me `false` hi rakho.** `true` karne se SSRF guard private aur
loopback addresses monitor karne lagta hai — matlab koi bhi authenticated user
tumhare internal network ki services probe kar sakta hai.

Sirf tab `true` jab tum jaante ho tum kya kar rahe ho (Docker compose me local
service monitor karna, waise case).

---

## Secrets

`wrangler.toml` me **kabhi nahi**. Ye command se jaate hain:

```bash
pnpm exec wrangler secret put <NAME>
```

### `CRON_SECRET` — **required**

Scheduled sweep ko authenticate karta hai. Iske bina koi bhi public caller
tumhara cron endpoint hit karke checks trigger kar sakta hai.

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

### `TOTP_SECRET`

Passphrase jo per-user TOTP seeds encrypt karke rakhta hai.

> TOTP enrol karne ke liye ye **zaroori** hai, aur koi built-in fallback key
> nahi hai — ek public default key rakhna security theatre hota.

### `ADMIN_USERNAME` / `ADMIN_PASSWORD`

Sirf `AUTH_MODE = "basic"` me. Docker jaise non-browser setups ke liye.

### Provider connection strings

| Secret | Provider |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso |
| `NEON_DATABASE_URL` | Neon |
| `NEON_DATABASE_URL_POOLER` | Neon (pooler, recommended) |
| `SUPABASE_DATABASE_URL` | Supabase |
| `DATABASE_URL` | local SQLite |

---

## Local development config

`.dev.vars` — gitignored, `.dev.vars.example` se copy banao:

```bash
cp .dev.vars.example .dev.vars
```

Ye `wrangler dev` padhta hai aur production jaisa behaviour deta hai. `.env`
supported nahi hai — Cloudflare bindings ka naam hai ye.

---

## Tuning cheat sheet

| Symptom | Change |
|---|---|
| Latency high, CPU time khatam | `CHECKS_PER_RUN` kam karo, `CHECK_COLOS` hatao |
| Kuch monitors late check hote hain | `CHECKS_PER_RUN` badhao (lekin cap yaad rakho) |
| D1 quota khatam | `RAW_CHECK_RETENTION_DAYS = 3` |
| 90d ke bars khali hain | Cron chalta hai? `MAINTENANCE_HOUR_UTC` check karo |
| Map khaali hai | Local dev me `request.cf` nahi aata — production me theek hai |
| Notification nahi ja rahi | `CRON_SECRET` mismatch, ya channel URL galat |

---

<a href="DEPLOYMENT.md">← Deployment</a> · <a href="../README.md">README</a>