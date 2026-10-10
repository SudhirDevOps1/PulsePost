## [Unreleased]

### Fixed

- **Monitor checks ran fully in parallel.** `Promise.allSettled` started every
  check in the slice at once. Two documented platform limits make that wrong
  rather than merely wasteful: Workers opens only **six** simultaneous
  connections per invocation, so the seventh request queues and the timing stops
  being ours to reason about; and the fifty-subrequest budget is one per check
  plus one per notification channel per transitioned monitor, so twenty monitors
  failing together with three channels each passed straight through the budget
  and the invocation was killed mid-sweep. Concurrency is now capped at six --
  the platform's own number -- by a small lane scheduler that preserves result
  order.

- **Polling ran in hidden tabs.** The app shell's status pill, the dashboard and
  the public status page each ran a `setInterval` unconditionally. A dashboard
  left open overnight in a background tab cost roughly 1,200 requests and 1.2M
  rows read against a 100,000 request and 5M row daily allowance, for a page
  nobody looked at. All three now go through `usePolling`, which holds no timer
  at all while `document.visibilityState` is hidden and catches up immediately
  on return, so coming back to a stale tab shows current numbers instead of
  waiting a full interval.

### Changed

- **The brand mark matches the product.** The favicon and the web manifest still
  carried the pre-clay palette -- a near-black tile and a mint green that no
  longer appear anywhere in the app -- so the tab icon and the running product
  disagreed. Both now use the brand lilac and green, and the manifest's
  background and theme colours are the current clay surface and accent. The
  favicon also declares a maskable icon and an `id`, which the manifest already
  implied but did not specify.

- **The running product links back to its source.** A footer on every
  authenticated page carries the project name, the MIT licence, a link to the
  repository and one to the issue tracker. An MIT deployment sitting on someone
  else's `workers.dev` should make both reachable without a separate trip to
  GitHub.

- README carries the brand mark, a platform-limits section with what each
  ceiling is actually costing, and the corrected database count.

### Verified

- 182/182 tests, typecheck clean. Confirmed live: footer renders with both
  repository links carrying `rel="noreferrer noopener"`, manifest serves the new
  palette, favicon returns 200.


## [Unreleased]

### Added

- **Ten notification transports**, taking the total to thirteen. Telegram, ntfy,
  Gotify, Stoat, Pushover, Pushbullet, PagerDuty, Opsgenie, Mattermost and
  Rocket.Chat join webhook/Slack/Discord.

  Channel creation is now a discriminated union on `type`, because a mandatory
  `url` never described half of these -- a Telegram bot token and a PagerDuty
  routing key are not URLs. The original three keep their exact shape, so
  existing callers are unchanged.

  PagerDuty and Opsgenie are stateful: the same dedup key / alias for one outage
  produces one `trigger` and one `resolve`, rather than a separate incident per
  check for as long as a monitor stays down.

  Mattermost and Rocket.Chat consume the Slack incoming-webhook shape, so they
  reuse that builder instead of carrying a near-identical copy that would drift
  the first time Slack changed theirs.

  Migration `0002_widen_channel_types` rebuilds `notification_channels` to widen
  the CHECK constraint -- SQLite cannot ALTER one. Existing rows are copied
  first and `created_at` is carried, so channel ordering does not shift.

- `CHANNEL_TYPES`, `CHANNEL_TYPE_LABELS` and `CHANNEL_TYPE_HINTS` are the single
  source for the transport set. `ChannelType` is derived from it in both
  `shared/types.ts` and `web/types.ts`, so the client cannot fall behind the
  server's validation.

### Changed

- **The overview is computed as a summary.** It used to call
  `listWithStatus({ limit: 500 })` -- materialising 500 monitor rows and joining
  the latest check per monitor, only to count them and discard them. The
  dashboard fetches the monitor list separately, so every page view paid twice.

  Status now comes from `alert_states`, which the sweep upserts on *every* check
  rather than only on transitions, so it is always current. A LEFT JOIN keeps a
  never-checked monitor in `total` while leaving it out of every status bucket,
  matching the old `current_status: null` behaviour.

- **Channel secrets are redacted by key, not by name.** `mapChannel` replaced
  only `url`, because that was all the original three transports had. Ten of the
  new ones have no URL at all, and a bot token or routing key is exactly as
  serious a credential -- masking `url` alone would have leaked every one of them
  in the list response.

### Verified

- 182/182 tests (17 new). The migration test asserts a pre-existing row survives
  the table rebuild, that all thirteen transports are accepted, and that
  `carrier-pigeon` is still refused.
- PagerDuty and ntfy payload formats were checked against official
  documentation. The other eleven are written against their documented-standard
  APIs but their docs could not be fetched in this environment; the README says
  so rather than implying uniform verification. Each channel has a Send test
  button.

- **AGENTS.md**, the first instruction file for this repository: the migration
  bundling trap, the Tailwind `var()` trap, the Node/workerd divergences, the D1
  rows-read billing model, and the two vacuous tests written and caught while
  fixing the dashboard bugs.

## [1.0.0]

### Added

**Monitoring**
- HTTP monitors — koi bhi method, headers, body, expected status range
- Multi-step DSL monitors — `login → token → authenticated call`
- Per-monitor latency warn/fail thresholds, aur downtime threshold before alerting
- Cron sweep — least-recently-checked fairness, retries, alert deduplication
- Multi-colo execution (`CHECK_COLOS`) — ek hi service ko kai Cloudflare edge
  locations se check karo
- SSRF guard — private/loopback/link-local/CGNAT block, DNS re-resolution, aur
  redirect ke baad dobara validation

**Dashboard**
- Live edge map (Leaflet) — har check kis colo se aaya
- Latency charts (Recharts), 90-day uptime bars, per-group rollups
- Server-side search (`?q=`), sort (`?sort=&order=`), pagination (`?offset=`)
- Sparklines (`?include_latency=1`)
- Stat cards, status dots, pulse rings — sirf `down`/`degraded` pe pulse karta
  hai, warna healthy state visual noise ban jaata hai

**Operations**
- Incidents — timeline updates, auto `resolved_at` derivation
- Notification channels — Slack, Discord, generic webhook, per-monitor policy
- Multi-user — admin / editor / viewer roles, TOTP 2FA, PBKDF2 passwords
- Audit log — har destructive action record hota hai
- Public status pages — per-group slug, koi login nahi

**UI**
- Incidents, Alerts, Team, Settings pages
- Theme toggle (light / dark / system), toasts, press feedback
- Favicon + web app manifest
- Search, sort, pagination — list size se independent

**Infrastructure**
- 6 database adapters — D1, Turso, Supabase, Neon, Hyperdrive, local SQLite —
  ek hi portable schema
- 157 tests, `pnpm verify` = imports + typecheck + tests

---

### Fixed in production verification

Ye sab deploy ke baad hi mile, kyunki local dev in situations ko reproduce nahi
karta.

- **PBKDF2 210k → 100k iterations.** workerd WebCrypto ceiling 100k pe hai aur
  silently reject karta hai; Node reject nahi karta. Do environment me alag
  behaviour — wahi password Node pe verify hota tha, Workers pe fail.
- **`options.fetchImpl(...)` ko method ki tarah call karna.** workerd me
  `Illegal invocation` deta hai; Node me chalta hai. Local variable pe bind kiya.
- **`POST /channels/:id/link` body ka `channel_id` `monitor_id` column me likh
  raha tha.** Ab `?monitor_id=` query param use hota hai.
- **D1 ka `LIKE` pattern 50 bytes tak hi process hota hai.** Longer pattern
  silently match karna chhodh deta hai. Schema validation ne `q` ko 48 chars
  tak cap kar diya — runtime pe unpredictable behaviour se behtar.
- **Monitor card ka pause button `opacity-0 group-hover:opacity-100` tha** —
  mobile pe invisible aur untappable. Ab hamesha visible.
- **Header 1024px pe horizontally scroll kar raha tha.** 8 nav items `sm:` se
  show ho rahe the; ab `lg:` se.
- **Recharts 908px pe atak raha tha** — grid items ka default
  `min-width: auto` hai, to shrink hi nahi hote the. `min-w-0` se fix.

---

### Fixed — design system

- **168 token utilities silently kuch nahi kar rahe the.** Sab
  `bg-[--color-surface-1]` form me likhe gaye the; Tailwind v4 bare `--var`
  shorthand ko arbitrary value me resolve nahi karta aur **koi rule generate hi
  nahi karta**. Buttons aur badges square the, inputs me inset wells nahi the,
  colour tokens DOM tak nahi pahunch rahe the. Ye UI likhne ke din se tha — kuch
  "broken" nahi, bas "unstyled" laga, isliye bacha raha. Saare `var()` form me
  badle gaye aur verify kiya: source ki 37 distinct utilities, compiled CSS me 0
  missing.
- **`--color-on-accent` stylesheet se delete ho raha tha.** Tailwind `@theme`
  entries tree-shake karta hai jinhe koi utility use nahi dikhati, aur `var()`
  references uske liye opaque hain. Tokens ab `:root` me hain, jo verbatim emit
  hota hai.
- **Chart ke Y-axis labels clip ho rahe the.** `margin={{ left: -18 }}` axis ko
  SVG ke bahar kheenchta hai; Recharts 46px reserve karta hai par sirf ~28px
  clip region ke andar rehta hai. Har label ka pehla digit kat raha tha —
  `136ms` → `36ms`.
- **Stat card grid toota hua tha.** 5 cards, 5 columns — `Overall` ko double
  width dene aur evenly divide hone dono ek saath possible nahi tha, to `lg:`
  niche 2 columns pe gir kar last card akela full-width row me stranded ho
  jaata tha. Ab 6 columns.
- **Sort `<select>` poori width le raha tha.** `inputClass` me `w-full` hai aur
  uske saath `w-auto` likhne se kuch nahi hota — dono single-class width
  utilities hain, winner Tailwind ke emit order se decide hota hai, class string
  ke order se nahi. `inlineSelectClass` variant banaya jo `w-full` omit karta
  hai.
- **"Avg latency" tile 24 ghante tak khaali rehta tha.** Wo `daily_status`
  rollups se aata tha jo nightly job banata hai — jabki usi monitor card pe raw
  checks se real number dikhta hai. Do sources ek hi measurement pe disagree
  kar rahe the. Ab 24h mean raw `checks` se aata hai.
- **Header 1024px pe 18px overflow.** Clay pills purane buttons se bhaari hain
  aur nav usi breakpoint pe aata hai. Overview pill ab `xl:` tak wait karta hai.

---

### Changed

- **Claymorphism redesign.** Har raised element teen shadows se bana — outer
  drop, inner dark, inner light — chaar named depths (`raised` / `tile` /
  `inset` / `pill`) ke saath taaki recipe magic numbers se na copy ho. Inputs
  use invert karte hain: inner shadows sides swap karte hain jisse roshni
  neeche-right se aati hai, jo hi well ko "dabba hua" dikhata hai.
- **Default theme `light`** (clay). Pehle `system` tha — claymorphism me dono
  themes equivalent nahi hain, `light` intended look hai aur `dark` reduced
  variant, to OS follow karna zyadatar visitors ko compromise deta.
- **Status colours saturated rakhe.** Card surface pe pastel green ~1.6:1 aur
  pastel red ~2.1:1 hota hai — graphical status dot ke 3:1 floor se bhi neeche.
  Status page pe ye stylistic preference nahi, ambiguity hai. Pastels surfaces
  carry karte hain, saturation meaning.
- **Accent do tokens me split.** Ek value dono kaam nahi kar sakti: white button
  labels ko 4.5:1 rakhne wali fill itni light hai ki 12px text ke liye padti
  nahi. Ab `--color-accent` (fill) aur `--color-accent-text`.
- **Typography `ui-rounded`.** Web font nahi — app zero third-party requests ke
  saath chalti hai, aur ek font file har icon se zyada cost karegi.
- **Edge map ka empty state compact.** Poori map height reserve karna 340px khaali
  space reserve karta tha — kisi bhi fresh instance ke pehle ghante me, dashboard
  ka teesra hissa, sirf ek message ke liye.

---

### Accessibility

- **WCAG AA audit: 0 failures** — 6 routes × 2 themes, har text-bearing element
  ka effective background transparent ancestors ke through resolve karke.
- `text-tertiary` canvas pe 2.63:1 tha. Wo decoration nahi — timestamps aur
  counts carry karta hai — to ab 4.5:1 clear karta hai.
- Admin badge accent ko text ki tarah use kar raha tha (4.30:1 light, 4.34:1
  dark). Ab `--color-accent-text`.
- `prefers-reduced-motion` respect hota hai — movement hata di jaati hai par
  acknowledgement nahi, warna press bilkul silent ho jaata.
- Keyboard focus pastel ground pe 3px outline + offset, warna subtle ring lost
  ho jaata.

---

### Performance

- **0 horizontal overflow** at 375 / 480 / 640 / 768 / 1024 / 1280 px across all
  six routes.
- Recharts aur Leaflet lazy-load — ~82 KB aur ~45 KB gzip, first paint se baad.
- Cold payload ~300 KB gzip.
- D1 queries per invocation 50 ke andar — `CHECKS_PER_RUN = 20` deliberate
  headroom hai.

---

<a href="../README.md">← README</a>