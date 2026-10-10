# AGENTS.md

Facts you would otherwise have to rediscover by breaking something first.
Everything here was verified against the repo, not inferred from filenames.

## Commands

```bash
pnpm verify              # the gate: gen:migrations -> fix:imports -> tsc -> tests
pnpm test                # tests only
pnpm typecheck           # tsc --noEmit
pnpm dev                 # build + wrangler dev
pnpm deploy              # build + wrangler deploy
```

**One test file:**

```bash
node --experimental-strip-types --test tests/password.test.ts
```

`pnpm verify` is the whole CI — there is **no GitHub Actions workflow and no
pre-commit hook**. If it is not green locally, nothing catches it.

## Traps

### A new migration does nothing until you regenerate

`migrations/*.sql` is bundled into `src/worker/db/migrations.generated.ts` at
build time. Workers has no filesystem, so there is no runtime read.

```bash
pnpm gen:migrations      # [gen-migrations] Wrote N migration(s)
```

Skipping this is silent: the file is written, the constraint stays old, and
inserts fail with a CHECK error that names a constraint you cannot find in the
schema. Migrations are applied in sorted filename order and never re-applied.

### Import extensions are mandatory

```ts
import { foo } from './bar.ts';   // yes, including .tsx files
```

Node's native TypeScript stripping does not resolve extensionless specifiers.
`pnpm fix:imports` normalises them; it is part of `verify` but not of `pnpm test`,
so a bare `pnpm test` can pass on imports that the build rejects.

### Tailwind tokens only work in the `var()` form

```tsx
className="bg-[var(--color-surface-1)]"   // correct
className="bg-[--color-surface-1]"        // silently generates NOTHING
```

All 168 occurrences of the bare form shipped at one point and the entire colour
system was inert — buttons square, tokens never reaching the DOM, no error
anywhere. Tailwind v4 does not resolve that shorthand in an arbitrary value.

Two related traps in the same stylesheet:

- Tokens live in **`:root`, not `@theme`**. Tailwind tree-shakes `@theme` entries
  it cannot see a utility using, and `var()` references are opaque to it — so a
  token declared in `@theme` and requested at runtime was dropped from the
  stylesheet entirely.
- Two width utilities of equal specificity do not resolve in class-string order.
  `w-auto` appended after `w-full` still loses. Use `inlineSelectClass`, which
  omits `w-full` rather than fighting it.

### The dev server port is not fixed

Wrangler takes the **next free port**. `pnpm dev` printed 8788 on a machine where
8787 was occupied. Read the "Ready on" line; do not hardcode 8787 in a script or
a test.

### `pnpm dev` has no hot reload, and a stale server looks like a failed fix

`pnpm dev` is `gen-migrations && vite build && wrangler dev`. That is a
**one-shot build**, then a static server. There is no HMR and no watching:
editing `src/web/**` changes nothing until the process is restarted. The bundle
hash is the tell -- if `index-XXXX.js` has the same name it had before your
edit, the build did not run.

Worse, a killed process can leave its server alive on a port. Two servers both
answering `/api/health` means browser checks are hitting whichever one the
browser already cached, which is how a verified fix appears to do nothing.

```powershell
Get-Process -Name node | ForEach-Object { $_.Kill() }
```

### A hook after an early return is gated, because `tsc` cannot see it

`pnpm check:hooks` runs inside `pnpm verify` and fails when a hook follows a
component's first `return`. React throws "Rendered fewer hooks than expected"
the moment the branch flips, so a component that renders an empty state until
data arrives crashes on its first successful render -- invisible to `tsc`, to
linting, and to every test that never exercises that transition.

The script was wrong three times before it was right, and **each wrong version
passed while the bug was still in the file**:

- it attributed a helper's `return` to whichever function came next;
- it could not find the body of a function whose signature spans lines, because
  the `}` and `{` of `}) {` cancel in the depth arithmetic;
- it matched `return` only at the body's own statement depth, so
  `if (!ready) { return <Skeleton />; }` was invisible to it.

If you change it, re-inject the bug and confirm it fails before trusting it.

### Local test credentials

- Dev admin: `local@pulsepost.local` / `LocalDev1234!x`
- Seeded demo: `demo@pulsepost.local` / `demo-Instance-2026!` (`node scripts/seed-demo.mjs`)

Local only. The production password is still the test value and must not be
treated as a secret anyone can rely on.

## Things that differ between Node and workerd

The test runner is Node; production is workerd. These diverge silently, and the
failure only appears after deploying:

| Code | Node | workerd |
|---|---|---|
| `pbkdf2` iterations | 210k fine | rejects above **100k** — use the `ITERATIONS` constant in `auth/password.ts` |
| `options.fetchImpl(...)` | works as a method | `Illegal invocation` — bind to a local first |
| `request.cf` | absent | present; local dev has no colo, so the edge map is empty locally |

## D1 bills rows read

Not bytes, not query count. A single wide scan per request exhausts the daily
allowance while every response still returns 200.

- **`daily_status` rollups first.** One row per monitor per day (~90) versus
  walking raw `checks` (~2,000 at a 5-minute interval over the retention
  window). `listWithStatus` was scanning raw history for the 90-day figure and
  consulting the rollup only as a fallback — the comment above the query
  described the right intent and the code did the reverse.
- **`alert_states.current_status` is maintained on every check**, not only on
  transitions (`checkers/sweep.ts`), so the overview can count from it instead of
  joining the latest check per monitor.
- **`SELECT *` is not a D1 cost.** A primary-key lookup reads one row either
  way. Removing 31 of them is churn, not optimisation.
- **Workers KV allows 1,000 writes/day free.** Caching a 30-second poll in KV
  exhausts that on its own. Use the Cache API, which bills requests.

Full numbers in `D1-AUDIT.md`.

## Migrations and schema drift

Three places must agree on the notification transport list, and only one of them
is enforced:

1. `migrations/0002_widen_channel_types.sql` — the `channels_type_check`
   constraint, the real source of truth
2. `CHANNEL_TYPES` in `shared/schemas.ts`
3. `BUILDERS` in `notifications/send.ts`

`ChannelType` in both `shared/types.ts` and `web/types.ts` is **derived** from
`CHANNEL_TYPES` rather than restated, so 2 and 3 cannot drift from each other
silently. Adding a transport is: one enum entry, one schema member, one builder,
one migration. SQLite cannot `ALTER` a CHECK constraint — the table has to be
rebuilt and the rows copied, which is why `0002` is as long as it is.

## Secrets are write-only, and that covers more than URLs

`mapChannel` in `routes/channels.ts` replaces **every** value in the stored
config with `***`, not just `url`. Half the transports have no URL, and a
Telegram bot token or PagerDuty routing key is exactly as serious. Masking only
`url` — which is all the original three-channel world needed — leaks the rest.

## Tests

Node's built-in runner, no framework.

```ts
import { LibsqlAdapter } from '../src/worker/db/providers/libsql.ts';

db = await LibsqlAdapter.create('sqlite', { url: `file:${join(dir, 'x.db')}` });
await db.migrate();
```

- Use the adapter **directly**, not `getDb()` — the latter reads provider config
  off a Worker `Env`, which does not exist under the test runner.
- `tests/api.test.ts` and friends drive the real `app` through `app.fetch` with
  a temp SQLite file, which exercises the whole middleware chain.
- On Windows, `rmSync` races the SQLite driver's file handle. The existing
  suites retry; copy that.
- **A test that passes with the bug still in place is worse than no test.** Two
  of these were written and caught during this work: one in `api.test.ts` whose
  fixtures never write a check row, so the assertion held either way; and one
  whose helper asked "did any raw-history query run" when the 24-hour query
  legitimately always does. Pin behaviour that can differ, and confirm it fails
  against the old code before trusting it.

## Committing

Never stage `wrangler.toml` (real `database_id`), `.dev.vars`, or `.env`. All
three are gitignored — verify with `git check-ignore` rather than assuming. The
repo is public.

`_reference_pingflare/` is an unrelated local reference checkout. It is
gitignored; leave it alone.

## Docs are written in Hinglish and are load-bearing

`README.md`, `docs/*.md`, `D1-AUDIT.md`, `CHANGELOG.md`. Two rules learned the
hard way:

- **Check every claim against the source before writing it.** The old README
  referenced `setup.sh` and `setup.ps1`, neither of which existed, and described
  `/setup` as a page when it is `POST /api/auth/setup`.
- **Do not document an intention as a feature.** An earlier plan listed thirteen
  notification transports; three existed. The docs say three.