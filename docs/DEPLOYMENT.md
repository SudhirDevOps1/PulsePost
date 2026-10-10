# Deployment

PulsePost ko Cloudflare Workers pe deploy karna hai. Koi domain nahi chahiye, koi
credit card nahi chahiye — `*.workers.dev` subdomain free milta hai.

---

## 1. Requirements

| Cheez | Version | Kyin |
|---|---|---|
| Node.js | 20+ | `--experimental-strip-types` chahiye tests ke liye |
| pnpm | 9+ | lockfile committed hai |
| Cloudflare account | free | D1 aur Workers dono free tier me hain |

Koi aur cheez nahi. Docker nahi, VPS nahi, external database nahi.

---

## 2. Pehli baar (D1 ke saath)

### Step 1 — clone aur install

```bash
git clone https://github.com/SudhirDevOps1/PulsePost.git
cd PulsePost
pnpm install
```

### Step 2 — config copy karo

```bash
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` gitignored hai — isme database ID aayegi, wo kabhi commit nahi karni.

### Step 3 — database banao

```bash
pnpm exec wrangler d1 create pulsepost-db
```

Ye ek `database_id` print karta hai. Use `wrangler.toml` me `[[d1_databases]]`
ke `database_id` me paste kar do.

> **Ye ID private hai.** Repo public hai, isliye `wrangler.toml` kabhi commit mat
> karna. `.gitignore` me pehle se hai — verify kar lena:
> `git check-ignore wrangler.toml`

### Step 4 — secret set karo

```bash
pnpm exec wrangler secret put CRON_SECRET
```

Value generate karne ke liye:

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

`CRON_SECRET` woh hai jo scheduled sweep authenticate karta hai. Ye ke bina
koi bahar se aapke cron endpoint par check trigger kar sakta hai.

Sirf D1 use kar rahe ho to **bas yehi ek secret zaroori hai.**

### Step 5 — deploy

```bash
pnpm deploy
```

Output me aapka URL aayega:

```
https://pulsepost.<your-subdomain>.workers.dev
```

### Step 6 — pehla admin banao

Browser me URL kholo. Onboarding screen aayega — pehla admin account bana do.

> `POST /api/auth/setup` sirf **ek** baar kaam karta hai. Uske baad 409 deta
> hai. Isliye step 6 ko skip mat karna — warna koi aur bhi pehle admin ban
> sakta hai.

---

## 3. Poora free tier budget

Cloudflare free tier ki limits, aur PulsePost kahan tak jaata hai:

| Limit | Free tier | PulsePost ka use |
|---|---|---|
| Requests/day | 100,000 | Dashboard polling ~5 req/min per open tab |
| CPU/request | 10 ms | Worker + cron dono me |
| Subrequests | 50 | `CHECKS_PER_RUN = 20` + notifications |
| D1 size | 500 MB | 7 din raw + 365 din rollup |
| D1 queries/invocation | 50 | Cron ek list + per-monitor checks |
| Cron triggers | 5 | 1 (`* * * * *`) |

**Workers free plan me cron `* * * * *` (har minute) deta hai.** Ye theek hai —
`CHECKS_PER_RUN` aapke monitor count se kam rakho taaki ek invocation me sab
checks na aayein. 20 monitors x 5 min interval comfortably chalega.

Budget khatam hone se pehle warning kaise milegi, wo
[`CONFIGURATION.md`](CONFIGURATION.md#retention) me hai.

---

## 4. Doosre database providers

`DB_PROVIDER` badlo, baaki code same rehta hai. Har provider ka connection
detail `wrangler.toml` ke `[vars]` me hai.

### Turso (LibSQL)

```bash
pnpm exec wrangler secret put TURSO_DATABASE_URL
pnpm exec wrangler secret put TURSO_AUTH_TOKEN
```

```toml
[vars]
DB_PROVIDER = "turso"
```

### Neon

```bash
pnpm exec wrangler secret put NEON_DATABASE_URL
```

```toml
[vars]
DB_PROVIDER = "neon"
```

### Supabase

```bash
pnpm exec wrangler secret put SUPABASE_DATABASE_URL
```

> **Pooler URL use karo**, direct URL nahi. PgBouncer transaction mode
> (`?pgbouncer=true` ya port 6543) chahiye — serverless connections otherwise
> `max_connections` se pehle hi khatam ho jaate hain.

```toml
[vars]
DB_PROVIDER = "supabase"
```

### Cloudflare Hyperdrive (PostgreSQL)

```bash
pnpm exec wrangler hyperdrive create pulsepost-pg
```

`wrangler.toml` me uska ID daalo, phir:

```toml
[vars]
DB_PROVIDER = "hyperdrive"
```

### Local SQLite (Docker / VM pe)

```bash
pnpm exec wrangler secret put DATABASE_URL   # file:./data/pulsepost.db
```

```toml
[vars]
DB_PROVIDER = "sqlite"
```

Migrations alag se chalani parti hain — Worker startup pe nahi hoti:

```bash
pnpm db:migrate
```

---

## 5. Custom domain (optional)

Free subdomain kaafi hai. Custom domain lagana ho to `wrangler.toml`:

```toml
routes = [
  { pattern = "status.example.com", custom_domain = true }
]
```

Certificate Cloudflare automatically manage karta hai.

---

## 6. Deploy ke baad

**Ye zaroor karo:**

1. **Onboarding complete karo** — pehla admin banao. Iske bina instance public
   rahega aur koi bhi admin ban sakta hai.
2. **Default password change karo** — agar demo seed chalaya tha to
   `demo-Instance-2026!` turant replace karo.
3. **Audit log check karo** — `/settings` me dekho ki setup ke baad koi
   unexpected account nahi bana.

**Verify karo:**

```bash
curl https://your-worker.workers.dev/api/health
```

```json
{
  "ok": true,
  "database": { "provider": "d1", "dialect": "sqlite", "latency_ms": 148 },
  "version": "1.0.0",
  "environment": "production"
}
```

---

## 7. Update karna hai

```bash
git pull
pnpm install
pnpm verify     # types + tests — deploy se pehle
pnpm deploy
```

Migrations `0001_init.sql` se aage badh rahe honge to non-Worker providers pe
`pnpm db:migrate` chalao. D1 pe migrations `deploy` ke saath lag jaati hain.

---

## 8. Rollback

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler rollback <version-id>
```

Data rollback nahi hota — schema changes forward-only hain. Isliye destructive
migrations ek baar me mat jodo.

---

## Troubleshooting

| Problem | Reason |
|---|---|
| `Database ID not found` | `wrangler.toml` me `database_id` galat ya missing |
| Cron chal hi nahi raha | `CRON_SECRET` set nahi, ya `wrangler.toml` me `triggers` missing |
| `Setup has already been completed` (409) | Pehle admin ban chuka hai — `/settings` se users dekho |
| Dashboard khaali hai | Sweep nahi hua. Deploy ke baad ek minute wait karo |
| Map khaali hai | Edge nodes tab dikhte hain jab `request.cf` colo de — local dev me nahi aata |
| 500 on D1 queries | D1 ke 50 queries/invocation cross ho gaye. `CHECKS_PER_RUN` kam karo |

Baaki [`RUNNING.md`](../RUNNING.md) me.

---

<a href="../README.md">← README</a>