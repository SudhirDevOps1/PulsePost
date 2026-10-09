# PROGRESS

Dense changelog of completed work. No markdown formatting beyond bullets.

## Phase 1 — Analysis & architecture

Deep-analyzed Pingflare (isala404/pingflare) into `ANALYSIS.md`.
- Reference clone at `_reference_pingflare/` (gitignored).
- Original stack: SvelteKit 5 + adapter-cloudflare, Workers + D1, esbuild wrapper that
  re-exports `fetch` and adds `scheduled()` so UI+API+cron ship as ONE Worker.
- Original's differentiator: multi-step JSON check DSL (extract `${var}` between steps) plus
  dual-granularity history (raw `checks` 7d, `daily_status` 365d).
- Catalogued 16 gaps to fix; 3 are critical: unsalted SHA-256 passwords, no rate limiting,
  and an SSRF primitive (DSL fetches arbitrary URLs).

Two blockers found and reported:
- `@tundralibs/drivers` does not exist on npm (verified against the registry).
  `cf-knex` exists but is v0.3.2 and heavy. Decision: hand-roll the adapter.
- Next.js/OpenNext exposes only a `fetch` handler; cron needs a custom wrapper importing the
  generated `.open-next/worker.js`. Decision: Hono + React, where `scheduled()` is native.
- Confirmed with user: Hono+React, hand-rolled adapter, pnpm, keep DSL + add simple HTTP monitors.

## Phase 2 — Backend foundation

Scaffold, database layer, auth, CRUD API, check engine, cron sweep.
- `DatabaseAdapter` interface over 6 providers / 2 dialects. `DB_PROVIDER` switches with no
  code change.
- Portable SQL migration `0001_init.sql`: TEXT UUID PKs, ISO-8601 UTC timestamps via
  `{{now}}` token expansion, `ON CONFLICT DO UPDATE` upserts, no AUTOINCREMENT / `datetime()`.
- `dialect.ts` rewrites `?` -> `$n` with a scanner that skips string literals, quoted
  identifiers and comments, so URLs containing `?` are safe.
- Auto-migration on first request, memoised per adapter, atomic per migration, `IF NOT EXISTS`
  throughout. Migrations are bundled at build time — no runtime fetch on cold start.
- Auth: PBKDF2-SHA256 210k iters + per-user salt + constant-time compare (replaces the
  original's unsalted SHA-256). Session tokens stored only as SHA-256 hashes. TOTP (RFC 6238)
  with replay protection. Basic-auth mode for Docker.
- Security: CSP with `script-src 'self'` (no unsafe-inline/eval), HSTS, X-Frame-Options DENY,
  nosniff, Referrer-Policy, Permissions-Policy. Zod on every route via a wrapper that throws
  `HttpError` so validation errors share the app's error envelope.
- Rate limiting: Workers `unsafe.bindings` ratelimit binding with a bounded in-memory
  sliding-window fallback for dev/Docker.
- SSRF guard: scheme allowlist, no credentials in URL, private/loopback/link-local/CGNAT/
  metadata blocking for IPv4+IPv6 (incl. IPv4-mapped), DNS re-resolution when available,
  manual redirect following with per-hop revalidation and cross-origin credential stripping,
  response body size cap.
- Check engine: HTTP + multi-step DSL with variable extraction, 11 assertion operators,
  degraded/down severity, transport-only retries.
- Cron sweep: least-recently-checked ordering for fairness under the 50-subrequest cap,
  batched multi-row INSERT, alert-state dedup so a monitor down for an hour alerts once.
- Notifications: Slack/Discord/webhook payloads, no SDKs.
- Edge map data: ~120-colo coordinate table for plotting `request.cf.colo`.

### Bugs found and fixed by tests

- `DEFAULT strftime(...)` is invalid SQLite — needs parentheses. PG `to_char` format string
  had embedded single quotes that terminated the SQL literal early.
- `@libsql/client` returns `columns` as `string[]` (not `{name,type}`) with pre-keyed rows;
  the first flattening attempt turned every column name into `undefined`.
- Missing `CHECK` constraints on `monitors.kind` / `checks.status` / `users.role`.
- Retry loop never fired: `runHttp` swallowed transport errors instead of throwing, so
  `runCheck` always returned after one attempt.
- `int()` config parser only accepted strings, so numeric values silently fell back to
  defaults (broke `AUTH_RATE_LIMIT` and would have broken every limit in Docker).
- `updateMonitorSchema.group_id` was `.nullable()` but not `.optional()`, so every PATCH
  omitting it failed validation.
- SSRF opt-out was inferred from `ENVIRONMENT=development`, which silently disabled the
  guard. Now an explicit `ALLOW_PRIVATE_TARGETS` flag, off by default everywhere.
- `__Host-` + `Secure` session cookie is rejected over plain HTTP, breaking local dev/Docker.
  Now scheme-aware: `__Host-` + Secure on HTTPS, plain name without Secure on HTTP.
- `@hono/zod-validator` returns its own `{success,error}` 400 shape by default instead of
  throwing, which bypassed the app's error envelope.
- `migrate()` memoises its result, so logging `applied` per request reported a fresh apply
  every time.

### Verification

- 105 tests passing across 4 suites: dialect/migration/CRUD (24), SSRF + check engine (39),
  end-to-end Hono API incl. auth, headers, rate limiting, IP allowlist (42).
- `tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- `pnpm build` -> 69 KB gzip frontend.
- `wrangler deploy --dry-run` -> 296 KB gzip, all bindings resolved.
- Verified live on `wrangler dev` (workerd): setup 201, login 200 + session, monitor create
  201, `169.254.169.254` blocked 400, `file://` blocked 400, overview 200, edge 200.

## Phase 3 — Rebrand + Dashboard UI

### Naming
Chose **PulsePost** over 30+ candidates. Verified against the npm registry: the
obvious names were already taken — `pulsegrid` (a real SDK), `edgepulse` (monitoring SDK),
`watchtower`, `sentinel`, `beacon`, `vigil`, `pulsar`. Web search killed the final candidate
`gridpulse`: it is a **power-grid monitoring company with a registered trademark**
(gridpulse.com), too close to a monitoring product. `pulsepost` is free, has no collision,
and maps to the architecture: each Cloudflare colo is a post, each check is a pulse.
Renamed across 12 source files, tests, SQL, docs and config. 0 leftovers, 105 tests still pass.

### Offline-first
`.npmrc` / `pnpm-workspace.yaml` moved the pnpm store into the project (`.pnpm-store`, 224 MB,
180 packages) so `pnpm install --offline --frozen-lockfile` works on a fresh machine.
`scripts/check-offline.mjs` scans `dist/` for remote assets, CDN hosts and web fonts — it fails
the build if anyone reintroduces a network dependency. Verified end to end: offline install 67ms,
build 6.7s, 105 tests, offline check clean.
Node's type-stripping loader rejects TS parameter properties; `MemoryLimiter` was rewritten with
explicit fields. Keep `src/` erasable-syntax-only.

### UI
Dark dashboard: stat tiles, Leaflet edge map, Recharts latency chart, monitor list with
90-day bars, monitor create/edit, groups admin, public status page. Responsive, `prefers-reduced-motion`
honoured, system fonts only, CSP-compatible.
Code-split: Leaflet 150 KB and Recharts 292 KB are lazy chunks, so login and the public status
page never download a mapping engine or a chart library.

### Bugs found by actually looking at it

Screenshots in a real browser caught things tests did not:

- **CARTO dark tiles now return "API KEY REQUIRED".** Every free keyless dark basemap has
  moved to requiring a key. Switched to keyless OpenStreetMap tiles plus a CSS invert filter
  on `.leaflet-tile-pane`, and removed cartocdn from the CSP.
- **`/status` rendered a blank page.** The `/api/public/status` empty-state early return omitted
  `incidents`, so the client crashed on `status.incidents.filter(...)`. Fixed the API to always
  return the full shape, and made the client defensive — a blank status page during an outage is
  the worst failure this app has.
- **No way to create monitor groups**, so the public status page could never be populated.
  Added `/api/groups` CRUD + a Groups admin UI. Deleting a group nulls `monitors.group_id`
  (history is preserved).
- **Sign-out did not sign you out.** `AppShell` cleared the server session but never flipped the
  app-level auth state, so the shell stayed mounted and polled a 401 endpoint forever.
  Lifted the callback into `App`.
- **Edge nodes were all red.** Status used "any failure in 24h" as down; with ~200 checks per
  colo that turns the whole map red within hours. Now uses failure *rate* thresholds
  (>=50% down, >=10% degraded).
- **Chart stats line overlapped the uptime panel** — Recharts' SVG was overflowing its box.
  The stats line now lives outside the fixed-height plot.
- **90-day bars drew 90 slots for 8 days of data.** The window now adapts to the earliest day
  that actually has data, and `include_uptime=true` on `/api/monitors` returns per-monitor daily
  rollups in one extra query.

### Verification

- 105 tests pass, `tsc --noEmit` clean under strict + noUncheckedIndexedAccess.
- Production build 17.8s; Worker 297 KB gzip.
- Verified live on `wrangler dev`: dashboard, map with real tiles, charts, `/monitors/new`,
  `/status`, `/groups` all render and function.

## Next

- Phase 4: `setup.sh` / `setup.ps1`, Docker compose.
- Phase 5: docs — README, DEPLOYMENT, CONFIGURATION, SECURITY, API (Hinglish).

## Known items to address

- Worker bundle is 296 KB gzip because `@neondatabase/serverless`, `postgres` and
  `@libsql/client` are all statically resolvable via dynamic import. A D1-only deploy carries
  ~200 KB of dead weight. Consider `wrangler` `rules` to exclude unused providers.
- Node's type-stripping loader forbids TS parameter properties, enums and decorators.
  Keep to erasable syntax if `pnpm test` is to keep working without a build step.