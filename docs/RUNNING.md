# RUNNING & TESTING (Hinglish guide)

> **Docs index:** [README](../README.md) · [Deploy](DEPLOYMENT.md) · [Config](CONFIGURATION.md) · [API](API.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Yeh file batati hai ki project ko **locally kaise chalana hai**, **test kaise karna hai**,
aur — sabse important — **bina internet ke kaise chalana hai**.

---

## 1. Ek line mein summary

| Kaam | Command (pnpm) | Internet chahiye? |
|---|---|---|
| Install (pehli baar) | `pnpm install` | ✅ haan |
| Install (offline, baad mein) | `pnpm offline:install` | ❌ nahi |
| Build | `pnpm build` | ❌ nahi |
| Local server chalao | `pnpm dev` | ❌ nahi |
| Tests | `pnpm test` | ❌ nahi |
| Type check | `pnpm typecheck` | ❌ nahi |
| Saara verify | `pnpm verify` | ❌ nahi |
| Offline check | `pnpm offline:check` | ❌ nahi |
| **Deploy** | `pnpm deploy` | ✅ **haan** (zaroori hai) |

---

## 2. Package manager: pnpm vs bun vs npm

Teenon kaam karenge, kyunki saare scripts **plain `node` calls** hain aur koi
`npm run`/`bun run` nested nahi hai:

```json
"build": "node scripts/gen-migrations.mjs && vite build"
```

Sirf `node` aur `node_modules/.bin` chahiye — jo teeno package managers dete hain.

### pnpm (recommended, yahi use karo)

```bash
pnpm install
pnpm dev
```

Is project ka default pnpm hai `.npmrc` mein (`store-dir=.pnpm-store`) aur
`../pnpm-workspace.yaml` mein approved build scripts ke saath.

### bun

**Sath mein `bun` install nahi hai** is machine pe. Use karna ho to:

```bash
bun --version          # check karo
bun install            # bun apna lockfile banayega (bun.lock)
bun run build
bun run test
```

Do baatein dhyan mein rakhna:

1. **`bun` Node scripts ko seedha run nahi karta** (wahan TS type-stripping built-in
   hai, par hamare `--experimental-strip-types` wale test command ko `node` chahiye).
   Isliye tests ke liye Node use karo: `pnpm test`.
2. `bun install` karne se `bun.lock` banega. **Lockfile ek hi rakho** — ya `../pnpm-lock.yaml`,
   ya `bun.lock`, dono nahi. Warna dependency resolve alag-alag ho jaata hai.

### npm

```bash
npm install
npm run build
npm test
```

Chalta hai, par lockfile ka format alag hota hai (`../package-lock.json`).

---

## 3. Bina internet ke chalao — 2 alag problems

Yahan sabse important baat: **"offline install" aur "offline run" alag hain.**
Bahut log inhe ek samajh lete hain aur phir production mein surprise hota hai.

### 3a. Offline INSTALL (taaki doosri machine pe bhi chal sake)

Problem: pnpm ka default store **global** hota hai (`D:\.pnpm-store`). Agar repo kisi
aur machine pe le jaao, wahan store nahi hai — matlab install ke liye internet chahiye.

Solution jo maine lagaya:

- `.npmrc` mein `store-dir=.pnpm-store` — store ab project ke andar hai.
- `pnpm fetch` se saare packages store mein aa jaate hain.

**Ek baar (online) mein:**

```bash
pnpm offline:prepare        # = pnpm fetch --store-dir .pnpm-store
```

Iske baad `.pnpm-store/` ko repo ke saath le jaao. Ab **kisi bhi machine pe, bina
internet ke:**

```bash
pnpm offline:install        # = pnpm install --offline --frozen-lockfile
```

> `.pnpm-store/` git mein **nahi** hai — 224 MB ka content-addressed blob history
> ko permanently bloat kar deta hai, aur woh `pnpm offline:prepare` se kabhi bhi
> dobara ban jaata hai. Air-gapped machine ke liye store ko archive karke saath
> bhejo:
>
> ```bash
> tar czf pnpm-store.tar.gz .pnpm-store     # ya Windows pe:
> # Compress-Archive -Path .pnpm-store -DestinationPath pnpm-store.zip
> ```

`--frozen-lockfile` zaroori hai — isse pnpm lockfile ke hisaab se hi lagega, warna
version badal kar offline install chupke se fail ho sakta hai.

Store ka size abhi **~224 MB** hai. Poora project (`node_modules` + store) ~540 MB
hai kyunki dev dependencies (wrangler/workerd, vite, typescript) bhi andar hain.

Sirf production dependencies chahiye to:

```bash
pnpm install --offline --frozen-lockfile --prod    # chhota, par build nahi hoga
```

> Production ke liye chahiye to normally `pnpm install` chahiye, `wrangler deploy`
> build karta hai. `--prod` sirf debugging ke liye hai.

### 3b. Offline RUN (app khud bina internet chale)

Ye **automatically nahi hota** aur isi liye maine ek check script likha hai.

Achhi baat: **Worker poori tarah local chalta hai.** `wrangler dev` ke andar real
`workerd` runtime hota hai, D1 local file mein banta hai. Usse kisi ko internet
ki zaroorat nahi.

Khatarnaak baat: **frontend mein chhupa hua network dependency.** Ek CDN `<link>`,
ek Google Font, ya map tiles — koi bhi ek cheez app ko offline-mode mein tod deti hai.
Main jaan-boojh ke ye nahi rakhta:

- ❌ Koi web font nahi — sirf system fonts (`ui-sans-serif, system-ui, …`)
- ❌ Koi CDN nahi — Leaflet CSS aur Recharts build ke andar bundle hote hain
- ✅ Sirf **OpenStreetMap tiles** — map ke liye (Phase 3 mein aayega)

Verify karne ke liye:

```bash
pnpm build
pnpm offline:check
```

Ye script check karta hai:
- `node_modules` hai ya nahi
- project-local store hai ya nahi
- lockfile hai ya nahi
- built `dist/` mein koi bhi **remote asset** (`<script src="https://...">`,
  `@import url(https://...)`) to nahi
- koi CDN host (jsdelivr/unpkg/googleapis) to reference nahi ho raha
- web fonts to nahi hain

Output aisa dikhta hai:

```
OK
  + project-local pnpm store present (.pnpm-store)
  + pnpm-lock.yaml present
  + no web fonts referenced — typography uses system fonts

No blocking problems found.
```

Exit code `0` = offline ke liye ready, `1` = koi blocking problem.

> **Note:** Script har `https://` string ko dikhata hai, par fail sirf tab karta hai
> jab woh *actually* remote asset load karta ho. Isliye React ke andar ke
> `react.dev` / `www.w3.org` strings warning aate hain, error nahi — woh sirf error
> message ke andar hote hain, fetch nahi hote.

### 3c. Jo **inherently** internet maangta hai

Ye project ka nature hai, isse bypass nahi kar sakte:

| Feature | Internet chahiye? | Solution |
|---|---|---|
| App khud chalao (`pnpm dev`) | ❌ | local workerd |
| Database (D1/Turso/Neon/Supabase) | ❌ local D1 ke liye | local SQLite bhi hai |
| **External URL monitor** | ✅ haan | — product hi yahi hai |
| **OSM map tiles** | ✅ haan | offline tile source (Phase 3) |
| **`pnpm deploy`** | ✅ haan | Cloudflare tak pahunchana zaroori hai |

**Pure offline monitoring** (bilkul bina internet) possible hai — local services
monitor karne ke liye:

```toml
ALLOW_PRIVATE_TARGETS = "true"   # localhost / private IP monitor karne ke liye
```

Iske baad `http://localhost:3000/health` jaise targets allow ho jaate hain. Ye flag
default mein **off** hai aur `ENVIRONMENT` se derive **nahi** hota — security control
ko kisi unrelated switch se na jodein.

---

## 4. Daily commands

### Pehli baar (online)

```bash
pnpm install
cp .dev.vars.example .dev.vars     # apne secrets daalo
pnpm dev                           # http://127.0.0.1:8787
```

Browser mein kholo → pehli baar account banega (setup screen) → phir monitors add karo.

### Cron ko locally test karo

`wrangler dev` cron ko **automatically trigger nahi karta** (ye normal hai). Manually:

```bash
# secret chahiye .dev.vars mein CRON_SECRET
curl -H "X-Cron-Secret: <secret>" http://127.0.0.1:8787/api/cron
```

Ya Workers ka local endpoint:

```bash
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

### Tests

```bash
pnpm test              # 105 tests, 4 suites
pnpm typecheck         # tsc --noEmit
pnpm verify            # migrations + imports + typecheck + tests
```

Test suites:

| File | Kya cover karta hai |
|---|---|
| `../tests/db.test.ts` | dialect translation, auto-migration, upsert, transactions, FK cascade, provider selection |
| `../tests/checker.test.ts` | SSRF guard (IPv4/IPv6/DNS), HTTP monitor, multi-step DSL, assertions |
| `../tests/api.test.ts` | Poora Hono app: security headers, auth, Zod, rate limiting, IP allowlist |

### Sab kuch ek saath

```bash
pnpm verify && pnpm build && pnpm offline:check
```

---

## 5. Offline bana rahe ho? Quick checklist

```bash
pnpm offline:prepare       # 1. store bharo (ONLINE, ek baar)
pnpm offline:install       # 2. offline install (NO INTERNET)
pnpm build                 # 3. build (NO INTERNET)
pnpm test                  # 4. tests (NO INTERNET)
pnpm offline:check         # 5. confirm (NO INTERNET)
```

Agar step 2 fail ho raha hai, yaar — matlab `.pnpm-store` complete nahi hai ya
`../pnpm-lock.yaml` change hua hai. Wapas online jao aur step 1 dobara chalao.

---

## 6. Folder layout

```
pulsepost/
├─ src/
│  ├─ worker/          # Backend — Hono API + cron
│  ├─ web/             # Frontend — React SPA
│  └─ shared/          # Dono ke beech shared types + Zod schemas
├─ migrations/         # Portable SQL (SQLite + Postgres dono ke liye)
├─ tests/
├─ scripts/            # Build + codemod + offline check
├─ .pnpm-store/        # Offline install ke liye vendored packages
└─ dist/               # Built frontend (Workers Static Assets serve karta hai)
```

`../src/worker` aur `../src/web` alag folders mein hain, par dono **ek hi Worker** se serve
hote hain — yahi is project ka core idea hai.