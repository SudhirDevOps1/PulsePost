# ROADMAP.md — PulsePost → Production-Ready Platform

> Poora plan ek jagah. Har phase ke end pe confirm maanga jayega.
> **Constraint:** kuch bhi remove nahi. Sirf add + improve.
> Research date: **9 October 2026**

---

## 0. Pehle seedhi baat — 3 cheezein jo brief me galat thin

| Brief me | Reality | Action |
|---|---|---|
| `@tundralibs/drivers` | npm par **publish hi nahi hua** | Hand-rolled adapter (already done) |
| Apprise (Python) | **Workers pe impossible** — Python sirf Pyodide se aata hai, jahan network egress blocked hai. Notification bhejna hi egress hai. Circular. | TypeScript `NotificationTransport` interface |
| Metagraph API | **Verify nahi hua** — site unreachable, search empty. Koi documented public notification API nahi mili | Tere se confirm karna hoga. Neeche detail hai |

> Teeno deviations deliberate hain. Maqsad (unified routing, no lock-in) poora hota hai — beech ka runtime nahi badla.

---

## 1. Competitor Analysis — 20 Tools

| Tool | Free tier | Notifications | Checks | DB | PulsePost vs. |
|---|---|---|---|---|---|
| **PulsePost** | 100% free, no card | 3 → **15+** | 60s | **6 providers** | — |
| Pingflare | Free | 8 | 60s | D1 | Hum jeette: 6 DB |
| Uptime Kuma | Unlimited | **90+** | **20s** | SQLite | Wo jeetta: notifications + interval |
| UptimeRobot | 50 | ~10 | 5min | SaaS | Free tier weak |
| Better Stack | 10 | many | 3min | SaaS | SaaS, code nahi milta |
| UptimeFlare | 50 | 100+ | 1min | D1 | Wo jeetta: geo (310+ cities) |
| Upptime | Unlimited | GitHub | 5min | Git | Wo: zero infra; humein repo chahiye |
| Checkmate | Free | few | — | Mongo/PG | Hardware focus |
| Gatus | Free | 12 | 30s | SQLite + YAML | Unhosted — hum free-host karte hain |
| Asura | Free | few | — | SQLite | 19 monitor types (hum: 2) |
| Peekaping | Free | few | — | SQLite/PG | 18 types + Terraform |
| Cairn | Free | few | — | SQLite | 5,000 monitors scale |
| Pingtower | Free | few | — | Local | Built-in dashboard |
| Uptop | Free | few | — | Local | SSH TUI only |
| Hyperping | 20 | — | — | SaaS | SaaS |
| Cronitor | Limited | — | — | SaaS | SaaS |
| Oh Dear | Unlimited sites | — | — | SaaS | Wo: SSL + broken links + perf — hum me nahi |
| Pingdom | **1 monitor** | — | 1min | SaaS | Trial only |
| StatusCake | 3 | — | 5min | SaaS | Bahut kam |
| Freshping | 50 | Email/Slack/SMS | 1min | SaaS | SaaS |
| Instatus | 15 | — | **30s** | SaaS | SaaS |
| HetrixTools | 15 + 32 | SMS/call | 1min | SaaS | SaaS |

### Competitive Position — 4 unique advantages

| # | Advantage | Kyun matter karta hai |
|---|---|---|
| 1 | **6 DB providers, `DB_PROVIDER` env var** | Baaki sab D1-only ya SQLite-only. Ek line badlo, poori database badal jaati hai |
| 2 | **Multi-step DSL, 11 assertion operators** | `login → token → authenticated call`. Kuma/Pingflare/Gatus — koi nahi |
| 3 | **Layered SSRF guard** | Scheme block + private/CGNAT/link-local + DNS re-resolution + redirect revalidation + size cap |
| 4 | **100% free, code tumhare paas** | Upptime bhi free, lekin GitHub Actions pe locked |

### 6 Gaps jo band karne hain

| # | Gap | Competitor | Kaise milega | Priority |
|---|---|---|---|---|
| 1 | **Notification breadth** (3 vs 90+) | Kuma, UptimeFlare | TypeScript transports — §3 | **P0** |
| 2 | **SSL cert expiry monitoring** | Kuma, Oh Dear | TLS handshake inspect | **P0** |
| 3 | **No light mode** (README claim karta hai jo exist nahi karta) | Kuma | Token system | P1 |
| 4 | **No geo/multi-region checks** | UptimeFlare | `CHECK_COLOS` already exists, **unused** | P1 |
| 5 | **Monitor types sirf 2** | Asura 19, Peekaping 18 | TCP/Ping/DNS/Keyword/Cron/Push | P2 |
| 6 | **No SLO tracking** | Gatus | SLO table + burn-rate | P2 |

---

## 2. Feature Gap

### P0 — Notifications (sabse bada gap)

Current: `webhook | slack | discord`

**12 naye transports**, sab Workers pe `fetch` se possible:

```
src/worker/notifications/
├─ send.ts          (existing orchestrator — unchanged)
├─ types.ts         NEW  NotificationTransport interface
└─ transports/
   ├─ webhook.ts    (HMAC signing add)
   ├─ slack.ts      (bot token + webhook)
   ├─ discord.ts
   ├─ telegram.ts   NEW
   ├─ ntfy.ts       NEW
   ├─ stoat.ts      NEW
   ├─ whatsapp.ts   NEW  (Twilio + Cloud API)
   ├─ sms.ts        NEW  (Twilio / ClickSend)
   ├─ email.ts      NEW  (Resend / SendGrid)
   ├─ pagerduty.ts  NEW
   ├─ opsgenie.ts   NEW
   ├─ pushover.ts   NEW
   ├─ gotify.ts     NEW
   ├─ pushbullet.ts NEW
   └─ metagraph.ts  NEW  (spec confirm karni hai)
```

Test button har channel ke liye: `POST /channels/:id/test` — **already exists**.

Config shape change hoga → additive migration, purana data safe rahega.

### P0 — SSL Expiry Monitoring

Kuma aur Oh Dear dono karte hain. Workers `fetch` certificate expose nahi karta, to `connect()` raw TCP socket se TLS handshake inspect karna padega.

**Honest note:** Free tier pe constrained hai. Implement karke test karunga; agar na chale to documented limitation banega.

### P1 — Multi-region Checks

`CHECK_COLOS` env var **already exists** aur read hota hai — **par use kahin nahi hota**.

Blocker: free tier **6 simultaneous connections**. 310 cities impossible. Sequential ya colo sampling. Docs me limit clearly likh ke.

### P2 — More Monitor Types + SLO

TCP · Ping · DNS · Keyword · JSON Query · Cron/Heartbeat · Push
`monitors.kind` CHECK constraint expand karna hoga (additive migration).

---

## 3. Notification APIs — Verified Research

Har channel ka **actual wire format**. Docs se verified, guess nahi.

### ntfy (docs.ntfy.sh/publish — verified)

Sabse flexible. Plain `POST` + headers:

```
POST https://ntfy.sh/<topic>
Title: <text>          (alias: X-Title, ti, t)
Priority: <1-5>        (alias: X-Priority, prio, p)   default 3
Tags: warning,skull    (alias: X-Tags, tag, ta)      emoji shortcodes
Markdown: yes
Click: https://...     (alias: X-Click)
Actions: view, Label, URL, clear=true
Icon: https://...      (PNG/JPEG only)
```

- **Topic = password** hai (no signup). Docs: *"pick something that's not easily guessable"*. Names `[-_A-Za-z0-9]`, max 64 chars.
- Self-hosted: base URL replace karo, same protocol
- Auth: `Authorization: Bearer tk_...`
- Max message 4,096 bytes text

### Telegram

```
POST https://api.telegram.org/bot<TOKEN>/sendMessage
{"chat_id": "<CHAT_ID>", "text": "...", "parse_mode": "HTML",
 "disable_web_page_preview": true}
```

### Generic Webhook + HMAC

Sabse important — isse har koi apna channel bana sakta hai:

```
POST <url>
Content-Type: application/json
X-PulsePost-Signature: sha256=<hmac-hex>
X-PulsePost-Event: down | up | degraded
X-PulsePost-Delivery: <uuid>        ← idempotency
X-PulsePost-Timestamp: <unix>
```

`hmacHex = HMAC-SHA256(secret, timestamp + "." + rawBody)`
Timestamp zaroori — warna replay attack possible.

### Baaki sab

| Channel | Endpoint | Auth |
|---|---|---|
| **Slack webhook** | `hooks.slack.com/services/...` | URL = secret |
| **Slack bot** | `slack.com/api/chat.postMessage` | `Bearer xoxb-…` |
| **Discord** | `discord.com/api/webhooks/<id>/<token>` | URL = secret |
| **Stoat** | stoat.chat webhook URL | URL = secret |
| **Twilio SMS** | `api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json` | Basic sid:token |
| **Twilio WhatsApp** | same + `From=whatsapp:+…`, `To=whatsapp:+…` | same |
| **WA Cloud API** | `graph.facebook.com/v21.0/<phone>/messages` | Bearer token |
| **Resend** | `api.resend.com/emails` | `Bearer re_…` |
| **SendGrid** | `api.sendgrid.com/v3/mail/send` | `Bearer SG.…` |
| **ClickSend** | `rest.clicksend.com/v3/sms/send` | Basic auth |
| **PagerDuty** | `events.pagerduty.com/v2/enqueue` | `Routing-Key` header |
| **Opsgenie** | `api.opsgenie.com/v2/alerts` | `Authorization: GenieKey <key>` |
| **Pushover** | `api.pushover.net/1/messages.json` | token + user key |
| **Gotify** | `<base>/message?token=<token>` | token |
| **Pushbullet** | `api.pushbullet.com/v2/pushes` | `Bearer <token>` |

### Metagraph API — tera input chahiye

Verify nahi hua:
- `metagraph.co` → **transport error** (unreachable)
- Web search → **zero results**
- Koi documented public notification API nahi mili

**3 possibilities:**
1. Real Constellation Network service hai jiska docs main nahi dhundh paya → tu spec de
2. Private/internal API hai → publicly use nahi kar sakte
3. Typo hai kisi aur ka

Bata de kya hai. Tab tak placeholder transport bana ke rakh dunga, par **"unverified"** mark karunga taaki koi production me depend na kare.

---

## 4. Custom App Icon

### Current state
- Favicon nahi — har page pe `/favicon.ico 404` (logs me confirmed)
- Logo inline SVG hai (`AppShell.tsx:148`) — sirf header me

### Plan (additive)

| Asset | Purpose |
|---|---|
| `public/icon.svg` | Scalable source-of-truth |
| `public/favicon.svg` | Modern browsers |
| `public/apple-touch-icon.png` | iOS home screen |
| `public/icon-192.png` / `icon-512.png` | PWA / Android |
| `manifest.webmanifest` | Installable app |
| `<link rel="icon">` | Wire-up |

**Design:** Current logo rakhta hoon (3 edge nodes + pulse line), minimalist version — single accent, cleaner geometry, 16px pe bhi readable.

PNG generation ke liye dev dependency chahiye hogi — **sirf devDependency**, runtime bundle me nahi jayegi. Free tier ka 64 MiB budget safe.

---

## 5. Free Tier Deployment — No Domain, No Card

### Reality (verified Oct 2026 docs)

| | Free | Asar |
|---|---|---|
| Workers requests | 100,000/day | Sabse tight constraint |
| CPU/request | **10 ms** | PBKDF2 100k + cold start borderline |
| Subrequests | 50 | `CHECKS_PER_RUN=20` sahi hai |
| Simultaneous connections | **6** | Multi-region limited |
| Cron triggers | 5 | Hamara 1 |
| D1 size | 500 MB | Retention tune |
| D1 queries/invocation | 50 | Bulk ops batch |
| **Credit card** | ❌ Zaroori nahi | Haan |
| **Domain** | ❌ Zaroori nahi | `*.workers.dev` free |

### Budget math

D1 queries aur cron subrequests **Workers request quota me count nahi hote** — sirf inbound HTTP:

```
Browser polling (30s, 1 user):  2880/day
Admin usage:                    ~500/day
Public status page:             ~300/day
Cron invocations:               1,440/day
                                ─────────
                                ~5,120/day  = 5% of 100k
```

**~20 users comfortably.** Viral spike pe **Error 1027**.

Route mode default **"fail open"** — quota cross hone pe Worker bypass ho jata hai, 1027 page nahi. Status page 404 dikhegi. Docs me likhunga.

### One-click script

```
setup.sh      (macOS/Linux/Git Bash)
setup.ps1     (Windows — tere machine ke liye)
```

Flow: login check → `d1 create` → `wrangler.toml` generate → `secret put CRON_SECRET` → deploy → live URL print.

**No card. No domain. 6 commands.**

---

## 6. Documentation (7 files, Hinglish)

| File | Content |
|---|---|
| `README.md` | Overview · features · **comparison table** (20 tools) · quickstart · screenshots |
| `DEPLOYMENT.md` | Cloudflare free (no domain/card) · Docker (Fly/Railway/VPS) · **har DB provider** |
| `CONFIGURATION.md` | **Har env var** — name, type, default, example, danger |
| `SECURITY.md` | Controls · threat model · reporting |
| `API.md` | **Har endpoint** + curl example |
| `CONTRIBUTING.md` | Setup, style, PR flow |
| `CHANGELOG.md` | Version history |

Screenshots real browser se capture karunga — placeholder nahi.

---

## 7. Security

Current ~95%. Remaining:

| Task | Why |
|---|---|
| CPU profiling report | 10 ms budget — measure + document |
| Audit log **read endpoint + UI** | Table likhi ja rahi hai, kabhi padhi nahi jaati |
| Webhook HMAC signing | Replay protection |
| CSP update for CartoDB | `basemaps.cartocdn.com` |

---

## 8. Execution Order

| Phase | Scope | Size |
|---|---|---|
| **1** | Analysis + research | done (`ANALYSIS.md`) |
| **2** | Design system: light/dark tokens · Editorial Minimal · **CartoDB Dark Matter** · **button feedback + toasts** · sparklines | Med |
| **3** | Custom icon + manifest + favicon | Small |
| **4** | **Notifications: 12 transports + HMAC + test buttons** | Big |
| **5** | Tags · bulk actions · export/import · audit log UI · concurrency cap 6 · multi-colo | Big |
| **6** | SSL expiry · monitor types (TCP/Ping/DNS/Keyword/Cron) | Med |
| **7** | SLO tracking + Gatus-style YAML | Med |
| **8** | **Docs: 7 files + screenshots + comparison table** | Med |
| **9** | `setup.sh` / `setup.ps1` + Docker + DEPLOYMENT walkthrough | Med |
| **10** | Final security pass + CPU profiling | Small |

Order ka logic: Icon (3) chhota + visible. Design system (2) baaki UI ka base. Notifications (4) sabse bada value, wo bhi free tier pe. Docs (8) features complete hone ke baad — warna stale likhenge.

---

## Confirm karne wali baatein

1. **Phase order theek hai?**
2. **Metagraph API kya hai?** (spec de, ya skip karun)
3. **Commit kar du pehle?** (23 files uncommitted — 4 bug fixes + 4 naye pages + 3 test files)