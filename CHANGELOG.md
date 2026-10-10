## [Unreleased]

### Fixed

- **A fresh deployment spent its entire daily D1 row allowance on its first
  day.** Measured on the live instance: **5M rows read in 24 hours** against a
  5M free-tier allowance, from 39k queries -- about 128 rows per query, where a
  list call should cost tens.

  The cause is a fallback that is correct on a mature instance and ruinous on a
  new one. `listWithStatus` reads `daily_status` first and scans the entire
  retained `checks` table for any monitor it cannot find a rollup row for. A new
  deployment has no rollup rows at all until its first nightly job, so for up to
  twenty-four hours *every* dashboard poll did a full-history scan -- to render a
  90-day uptime figure that honestly displays an em dash, because there is no
  data for it. The dashboard calls the function twice per page view.

  `daily_status` is now folded once an hour rather than once a night, gated on
  the UTC minute being 0. A new instance has real bars within the hour instead of
  at the next midnight, and the fallback stops firing. The rollup also runs on
  the path where no monitor is active: "nothing is being checked" and "there is
  nothing to report" are different states, and a deployment whose monitors are
  all paused has real history the status page is trying to show.

  This also fills the empty status-page bars, which were a symptom of the same
  gap rather than a separate problem.

### Changed

- **`runSweep` accepts an injectable clock.** The rollup gate is
  `getUTCMinutes() === 0`, which is the entire mechanism. Without a seam there
  that condition was testable only by waiting for the top of an hour, so the
  assertion protecting the row allowance would have been skipped or made to pass
  for the wrong reason.

- **`aggregateDaily`'s comment described a different algorithm from its query.**
  It claimed `ON CONFLICT ... DO UPDATE` used "additive aggregates"; the
  statements are assignments -- `total_checks = excluded.total_checks` -- over a
  fresh recompute of the day, so re-running is a no-op rather than a doubling.
  Taken at face value the comment reads as "do not call this twice", which is
  precisely the belief that would have caused the hourly fix above to be
  rejected for a reason that does not exist.

### Verified

- 185/185 tests (3 new in `tests/hourly-rollup.test.ts`), typecheck clean,
  `pnpm verify` exit 0.
- The new tests were confirmed to **fail against the pre-fix behaviour** (2 of 3
  fail with the hourly call disabled) rather than merely passing alongside it.
- One of them pins that a second rollup does not double the totals, which is the
  question that decides whether running this hourly is safe at all.

### Not fixed, deliberately

The fallback itself is untouched. It is what makes a fresh instance able to show
*something* before its first rollup, and bounding it would change what that is.
The cost was coming from it running continuously for a day, not from it existing.


## [Unreleased]

### Added

- **Real rasterised icons, generated from the SVG.** `node scripts/make-icons.mjs`
  renders `public/favicon.svg` into 16, 32, 180, 192, 512 and 1024 PNGs. The SVG
  stays the source of truth; the PNGs are committed output.

  These exist because an SVG favicon is correct on one modern desktop browser
  and wrong nearly everywhere else, in ways nobody notices until the site is
  shared or installed:

  - **iOS ignores an SVG `apple-touch-icon` outright** and screenshots the page
    instead. The icon is not used at all.
  - **Windows launchers and most desktop shells prefer a raster file** and fall
    back to a generic globe when only SVG is offered.
  - **A browser only falls through to a later `<link>` when an earlier one fails
    to parse**, not when it merely renders at the wrong size -- so the PNG has to
    come first in the list, not merely be present in it.

- **The status page leads with the answer instead of a paragraph.** The headline
  is now a full-width banner: the state at 3xl, an up/degraded/down counter
  across published monitors, and the whole reporting window drawn as one strip
  with an average-daily-uptime figure. It replaces three lines of centred text
  and then a list, which answered none of the three questions a reader arrives
  with.

### Fixed

- **The README logo never rendered.** GitHub rewrites a relative image path to
  its camo proxy only for Markdown `![]()` syntax; a raw `<img src="...">` is
  passed through untouched, so the browser resolved it against
  `github.com/owner/repo` rather than `.../blob/main/`, the request 404'd, and
  the reader saw the alt text. Confirmed against GitHub's rendered HTML, which
  was `<a href="public/favicon.svg"><img src="public/favicon.svg"></a>` -- the
  raw path, unrewritten. It is now `![PulsePost](public/icon-192.png)`. PNG
  rather than SVG because the mark has a `viewBox` and no intrinsic `width`, so
  a Markdown image would have no size for the browser to lay out.

- **The tab showed a generic globe.** See the iOS and launcher notes above; the
  `<link>` list now leads with 32px and 16px PNGs and keeps the SVG last.

- **The manifest declared no usable icon.** Every entry pointed at the same SVG
  with `sizes: "any"`, which is not a size any platform can act on. It now lists
  real PNGs at their real dimensions, keeps a maskable entry, and declares
  shortcuts for Dashboard, Add monitor and Alerts.

- **Open Graph tags were absent**, so a shared link rendered as a bare URL card
  with no title and no image.

### Verified

- 182/182 tests, typecheck clean, `pnpm verify` exit 0. All six assets confirmed
  served with the correct content type (`image/png`, `image/svg+xml`,
  `application/manifest+json`) and a real byte count.


## [Unreleased]

### Added

- **The Response time panel can be pointed at any monitor.** It silently
  auto-selected one and the only clue was a small subtitle, so with several
  monitors configured the number on the chart belonged to nobody the reader
  could identify, and there was no way to reach a different one. A picker in the
  panel header lists every active monitor and pins the selection -- auto-selection
  is now a *default*, not a policy, because silently swapping the chart every
  time a monitor goes down makes it impossible to read a single series from,
  which is the one thing a latency chart is for. The panel also leads with the
  selected monitor's own current latency rather than only the fleet-wide average.

- **`pnpm check:hooks`, wired into `pnpm verify`.** Fails the build when a hook
  follows a component's first `return`. React throws "Rendered fewer hooks than
  expected" the moment the branch flips, so a component that renders an empty
  state until data arrives crashes on its first successful render -- invisible to
  `tsc`, to linting, and to any test that never exercises the transition. One
  such bug was live in the latency chart while this work was in progress.

### Fixed

- **The latency chart's time axis lied about spacing.** The x axis was
  categorical, so Recharts gave every check equal width regardless of when it
  happened: a monitor on a five-minute interval and one checking twice in five
  minutes drew identically, and a gap in checks did not appear as a gap. The axis
  is now temporal (`dataKey="t"`, `scale="time"`).

- **Duplicate axis labels.** Points were labelled `HH:MM` unconditionally, so
  every check inside the same minute rendered the same string -- on a
  ninety-second window the axis read `01:18 PM` six times. Labels now scale with
  the range: seconds under ten minutes, `HH:MM` under twelve hours, date and time
  under two days, date beyond. Tooltips use the same tiers.

- **The chart did not say what window it covered.** `avg 173ms` reads as
  equivalent whether it covers four minutes or four days, which is the
  difference between a blip and a regression. The stats line now carries the
  span.

- **The fleet average and the chart were unqualified.** The stat tile reads
  `24h mean across all monitors` and the panel reads `Per-monitor latency over
  the last 120 checks`. With several monitors the two numbers are unrelated, and
  leaving both unqualified was the fastest way to answer "why do these
  disagree?" wrongly.

### Verified

- 182/182 tests, typecheck clean, `pnpm verify` exit 0. Confirmed in the browser
  against ten monitors: the picker switches both the chart and its headline
  number, the selection survives a poll that would otherwise reset it to
  auto-pick, all six axis labels are distinct, and the console is free of React
  hook errors.


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