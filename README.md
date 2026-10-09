# PulsePost

**Ek Cloudflare Worker. Poora uptime monitor. Paanch database. Zero vendor lock-in.**

PulsePost ek self-hosted uptime aur status-page monitor hai jismein frontend aur
backend ek hi Cloudflare Worker mein rehte hain — koi alag API host nahi, koi
alag frontend deploy nahi. Poora project free tier pe chalta hai aur database
ek env var badalne se kisi bhi doosre provider pe shift ho jaata hai.

> **Demo credentials (local dev):** `demo@pulsepost.local` / `demo-Instance-2026!`
> — sirf local instance pe. Production pe inhe turant change kar do.

---

## Kyun alag hai

| | PulsePost |
|---|---|
| **Deploy unit** | Ek Worker — SPA + API + cron, sab ek |
| **Database** | D1 · Turso · Supabase · Neon · Hyperdrive · local SQLite |
| **Vendor lock-in** | Koi nahi — `DB_PROVIDER` badlo, bas |
| **Telemetry** | Koi nahi. Koi bhi data bahar nahi jaata |
| **Cold start** | Hono + Workers native, ~300 KB gzip |
| **License** | MIT — apne hisaab se self-host karo |

---

## Database provider badlo

Yahi ek step poori lock-in khatam kar deta hai. `DB_PROVIDER` set karo, baaki
code same rehta hai:

| Provider | `DB_PROVIDER` | Extra setup |
|---|---|---|
| Cloudflare D1 | `d1` | `wrangler d1 create pulsepost-db` |
| Turso (LibSQL) | `turso` | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Supabase | `supabase` | `SUPABASE_DATABASE_URL` (pooler URL use karo) |
| Neon | `neon` | `NEON_DATABASE_URL` |
| PostgreSQL | `hyperdrive` | `wrangler hyperdrive create` |
| Local SQLite | `sqlite` | `DATABASE_URL=file:./data/pulsepost.db` |

Schema ek hi file hai — `migrations/0001_init.sql` — jo SQLite aur Postgres
dono pe bina badle chalti hai. Placeholder rewriting aur boolean handling
`src/worker/db/dialect.ts` mein hai.

---

## Features

**Monitoring**
- HTTP monitor — koi bhi method, headers, body, expected status range
- Multi-step DSL — `login → token → authenticated call`, 11 assertion operators
- 11 assertion types: status, body contains, JSON path, regex, latency, headers
- Cron sweep — least-recently-checked fairness, retries, alert deduplication
- Per-monitor thresholds: latency warn/fail, downtime threshold before alerting

**Dashboard**
- Live edge map (Leaflet) — har check ka Cloudflare colo
- Latency charts (Recharts), 90-day uptime bars, per-group rollups
- Public status pages — per-group slug se, koi login nahi chahiye
- Dark/light, responsive, code-split (Leaflet aur Recharts lazy load hote hain)

**Operations**
- Incidents — timeline updates, auto `resolved_at` derivation
- Notification channels — webhook / Slack / Discord, per-monitor policy
- Multi-user — admin / editor / viewer roles, TOTP 2FA, PBKDF2 passwords
- Audit log — har destructive action record hota hai

**Security**
- SSRF guard — private/loopback/link-local/CGNAT block, DNS re-resolution, redirect revalidation
- CSP (`script-src 'self'`), HSTS, rate limiting, Zod validation, CORS, IP allowlist
- Webhook URLs write-only — store hote hain, kabhi return nahi hote
- Session tokens ke hash store hote hain — DB leak se cookie usable nahi banta

---

## Quick start

```bash
git clone https://github.com/SudhirDevOps1/PulsePost.git
cd PulsePost
pnpm install
pnpm verify        # types + tests
pnpm dev           # http://127.0.0.1:8787
```

Pehli baar chalate waqt `wrangler.toml.example` ko `wrangler.toml` mein copy karo
aur browser pe `/setup` pe jaake admin account banao.

### Offline install

Poori tarah bina internet ke chal sakta hai — pnpm store project ke andar vendored hai:

```bash
pnpm offline:install    # --offline --frozen-lockfile
pnpm offline:check      # verify karta hai ki kya kya missing hai
```

Details ke liye [`RUNNING.md`](RUNNING.md) dekho.

---

## Commands

| Command | Kya karta hai |
|---|---|
| `pnpm dev` | Build + local Worker |
| `pnpm build` | Production build |
| `pnpm deploy` | Cloudflare pe deploy |
| `pnpm test` | Test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm verify` | Sab kuch — build, types, tests |
| `pnpm db:migrate` | Migration chalao (non-Worker DBs ke liye) |
| `pnpm offline:prepare` | Offline store banao |

---

## Architecture

```
src/
├── worker/           # Backend — ek Hono app
│   ├── routes/       # monitors, groups, incidents, channels, users, auth
│   ├── db/           # 6-provider adapter + portable SQL dialect
│   ├── checkers/     # HTTP + DSL engine, SSRF guard, cron sweep
│   ├── auth/         # PBKDF2, TOTP, sessions
│   └── middleware/   # security headers, CORS, rate limit, identity
├── shared/           # Types + Zod schemas ( dono taraf share hote hain )
└── web/              # React + Vite SPA
```

Database abstraction `src/worker/db/types.ts` mein ek interface hai. Naya provider
add karna hai to ek adapter likho, baaki code untouched rehta hai.

---

## Documentation

| File | Kya hai |
|---|---|
| [`RUNNING.md`](RUNNING.md) | Local setup, offline install, troubleshooting |
| [`ANALYSIS.md`](ANALYSIS.md) | Design decisions aur architecture rationale |
| [`PROGRESS.md`](PROGRESS.md) | Changelog — kya bana, kya bugs mile |

---

## Security

Koi vulnerability mili ho to report karein — public issue ke bajaye
private channel prefer karenge. Details [`SECURITY.md`](SECURITY.md) mein.

---

## Contributing

Issues aur PR welcome hain. Chhote changes pehle `pnpm verify` chala lein.

---

## License

MIT — [`LICENSE`](LICENSE)