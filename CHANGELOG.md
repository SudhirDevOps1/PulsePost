# Changelog

PulsePost ka pura itihas. Format [Keep a Changelog](https://keepachangelog.com/) ke
mutabiq hai, versions [Semantic Versioning](https://semver.org/) ke saath.

---

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