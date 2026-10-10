# Contributing

PulsePost pe contribute karna welcome hai. Chhote changes ke liye
`pnpm verify` chala ke PR kholo.

---

## Local setup

```bash
git clone https://github.com/SudhirDevOps1/PulsePost.git
cd PulsePost
pnpm install
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
pnpm dev
```

`http://127.0.0.1:8787` (port already busy ho to agla free port — terminal me
print hota hai).

Pehla admin onboarding screen se banao. Demo data chahiye to:

```bash
node scripts/seed-demo.mjs http://127.0.0.1:8787
```

### Offline

```bash
pnpm offline:install
pnpm offline:check
```

---

## Checks

```bash
pnpm verify      # imports + typecheck + tests — yehi CI chalta hai
pnpm typecheck   # tsc --noEmit
pnpm test        # 157 tests
pnpm build       # vite production build
```

PR bhejne se pehle `pnpm verify` clean hona chahiye.

---

## Code conventions

### Types

- `strict` mode, `any` nahi. Unknown shape ke liye `unknown` + narrowing use karo.
- Worker aur web dono ke schemas `src/shared/schemas.ts` me Zod se — **dono taraf
  ek hi definition**, taaki frontend aur backend kabhi disagree na kar sakein.

### Comments

Comment **kyu** likho, **kya** nahi.

```ts
// ❌ bad: increments the counter
counter++;

// ✅ good: the cap is 50 queries per D1 invocation, and a sweep of 20
// monitors must leave room for the notification fan-out.
const CHECKS_PER_RUN = 20;
```

Ek comment jo non-obvious trade-off record karta hai, agle maintainer ke liye
sabse valuable line hoti hai.

### Database

- SQL **portable** rakho — SQLite aur Postgres dono pe chalna chahiye.
  `AUTOINCREMENT`, `datetime('now')`, `INSERT OR REPLACE`, `GROUP_CONCAT` /
  `string_agg` mat likho. Placeholders `{{now}}` aur `{{now_date}}` use karo,
  `src/worker/db/dialect.ts` inhe engine ke hisaab se rewrite karta hai.
- `LIMIT`/`OFFSET` ke saath count avoid karo — `has_more` pattern behtar hai.

### UI

- **Tokens ko `var()` ke saath reference karo**: `bg-[var(--color-surface-1)]`.
  Bare `--var` shorthand (`bg-[--color-surface-1]`) Tailwind v4 me rule generate
  **nahi** karta — 168 aise occurrences poore design system ko invisible kar
  chuke the. Naya likhte waqt `var()` bracket ke andar hai, ye verify karna hai.
- Naye colours token banao, hardcoded hex nahi. Dark theme sirf tab kaam karega
  jab value token ke through aaye.
- Contrast: text ke liye WCAG AA (4.5:1), graphical elements ke liye 3:1.
  Pastel surfaces theek hain, lekin status colours saturated rehne chahiye —
  pastel status dot 3:1 bhi nahi cross karta.

---

## Tests

`tests/` me Node ka built-in runner (`node --test`), koi framework nahi.

```bash
pnpm test
node --experimental-strip-types --test tests/password.test.ts   # ek file
```

Har bug fix ke saath regression test likho, aur pehle usse **fail** hoke
dikhana — test jo fix ke bina pass ho jaata hai wo kuch check nahi karta.

DB-dependent tests ke liye in-memory adapter available hai; real D1 mock karne
ki zaroorat nahi.

---

## Commit messages

Conventional-ish, aur **kyu** batao:

```
fix: chart axis labels were clipped by a negative margin

A negative left margin pulls the Y axis outside the SVG, so Recharts
reserved 46px for it but only ~28px was inside the clip region. The
leading digit of every label was sheared off — "136ms" rendered as
"36ms". Claim the width instead of saving it.
```

---

## PR flow

1. Branch banao: `git checkout -b short-description`
2. Chhote commits, har ek self-contained
3. `pnpm verify` clean
4. PR kholo — **screenshots** design ya UI changes me (haan, `scripts/shoot.mjs`
   hai iske liye)
5. Secret dhyan rakhna: `wrangler.toml`, `.dev.vars`, `.env` kabhi commit nahi

---

<a href="../README.md">← README</a>