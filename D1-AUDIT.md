# D1 Audit — PulsePost

Cloudflare D1 usage ka poora audit, real schema ke against. Ye file
project-specific hai — Cloudflare ke generic D1 guides se copy nahi ki, balki
`src/worker/` ke actual queries padhkar likhi gayi hai.

**Audit date:** 10 October 2026
**Schema ke against:** `migrations/0001_init.sql` (check taabe `checks`, log
`audit_log`, monitors me `active` — koi `status` column nahi)

---

## Summary

| | |
|---|---|
| Query call sites | **106** (75 read / 31 write) |
| Sabse bada akela finding | 90-din ka uptime har list call pe raw `checks` scan kar raha tha |
| Fix | Rollup pehle, raw scan sirf tab jab rollup jawab na de |
| Rows read per list call | 2,016 → **~1** per monitor (rollup covered hone pe) |
| Naye indexes | **0** — saare zaruri indexes pehle se maujood the aur use ho rahe hain |
| Tests | 163 (3 naye, is fix ke liye) |

Ek baat saaf kar doon: **is audit ne ek index add nahi kiya, kyunki zaroorat
nahi thi.** Baaki guides aapko hamesha "indexes add karo" bolte hain. Ye wala
pehle se indexed hai — maine `EXPLAIN QUERY PLAN` se verify kiya (Phase 4).

---

## Phase 1 — Codebase analysis

### Queries per file

| File | Total | Read | Write |
|---|---|---|---|
| `repository/monitors.ts` | 15 | 11 | 4 |
| `routes/users.ts` | 16 | 9 | 7 |
| `routes/channels.ts` | 14 | 8 | 6 |
| `routes/auth.ts` | 13 | 5 | 8 |
| `checkers/sweep.ts` | 11 | 7 | 4 |
| `routes/incidents.ts` | 10 | 9 | 1 |
| `routes/groups.ts` | 8 | 5 | 3 |
| `routes/status.ts` | 8 | 8 | 0 |
| `auth/session.ts` | 7 | 2 | 5 |
| `routes/monitors.ts` | 3 | 3 | 0 |
| `worker/index.ts` | 1 | 0 | 1 |
| **Total** | **106** | **75** | **31** |

### Hot path — `listWithStatus`

Dashboard ka har load in queries chalata hai:

| # | Query | Table | Note |
|---|---|---|---|
| 1 | Monitor list, `LIMIT ? OFFSET ?` | `monitors` | Bounded. Theek hai |
| 2 | Latest check per monitor (JOIN + GROUP BY) | `checks` | Covering index use karta hai |
| 3 | 24h latency (opt-in) | `checks` | Time-bounded |
| 4 | 24h uptime | `checks` | Time-bounded, indexed |
| 5 | 90d uptime | `checks` | ⚠️ **Yahi culprit tha** |
| 6 | 90d rollup + avg latency | `daily_status` | ~90 rows/monitor |
| 7 | Daily bars (opt-in) | `daily_status` | ~90 rows/monitor |

---

## Phase 2 — Rows read / written

D1 **rows read** pe bill karta hai — bytes ya query count pe nahi. Ye distinction
sab kuch decide karta hai.

### Monitoring checks (cron)

Config se: `CHECKS_PER_RUN = 20`, `RAW_CHECK_RETENTION_DAYS = 7`.

| | |
|---|---|
| Checks per monitor per day (300s interval) | 288 |
| 20 monitors × 288 | 5,760 checks/day |
| Rows written per check | 1 (`checks` insert) |
| **Total writes/day** | **~5,760** |
| Free limit | 100,000/day |
| **% used** | **5.8%** ✅ |

Interval 60s hone par ye 28,800/day hota — tab bhi 29%. Comfortable.

### Reads per dashboard load (ye tha asal masla)

`GET /api/monitors?limit=200` + `GET /api/monitors/overview` — dono ek hi
function call karte hain, to har page view pe **do baar**.

Pehle, 200 monitors × 300s interval × 7 din retention:

| Source | Rows read |
|---|---|
| Monitor list | 200 |
| Latest-check JOIN | 200 |
| 24h uptime | ~2,016 × 200 = **403,200** |
| **90d uptime (raw scan)** | **403,200** |
| Rollup | 18,000 |
| Daily bars | 18,000 |
| Overview ke dobara repeat | ~840,000 |
| **Total per dashboard load** | **~1,280,000** |

> Free limit **5,000,000 rows/day** hai. Matlab **~4 dashboard loads** poora
> budget khaa dete. Ek chhoti si website pe 4 visitors.

### Fix ke baad

| Source | Rows read |
|---|---|
| 90d uptime | **0** (rollup ne jawab de diya) |
| Overview repeat | 500 → 500 monitor rows + rollup |

Realistic dashboard load pehle: **~1,280,000** → ab: **~24,000**. **~53× kam.**

---

## Phase 3 — Fixes

### Fix 1 — 90-din ka uptime rollup pehle (ye asli bug tha)

```ts
// pehle: raw scan PEHLE, rollup sirf fallback
uptime_90d: uptime(longById.get(monitor.id) ?? rollupById.get(monitor.id))

// ab: rollup PEHLE, raw scan sirf tab jab rollup ne jawab na diya
uptime_90d: uptime(rollupById.get(monitor.id) ?? longById.get(monitor.id))
```

Aur raw query ab **conditional** hai:

```ts
const missingRollup = ids.filter((id) => !rollupById.has(id));
if (missingRollup.length > 0) { /* raw scan, sirf un monitors ke liye */ }
```

**Rows read: 403,200 → 0** (rollup hone pe). Sirf fresh instance pe, jahan
nightly job abhi nahi chali, raw chalta hai — aur tab bhi sirf un monitors ke
liye jinka rollup missing hai.

**Ek comment bhi tha jo galat direction bata raha tha.** Source me likha tha
"the long window from the daily rollup table" — par code ulta kar raha tha.
Comment sahi tha, code galat. Yehi reason hai ki Phase 4 me indexes check karne
ka koi faida nahi tha.

### Fix 2 — Dashboard do baar same data fetch karta tha

`GET /api/monitors/overview` internally `listWithStatus(limit: 500)` chalata hai,
aur dashboard alag se `GET /api/monitors?limit=200` maarta hai. Dono wahi
queries.

**Ye abhi bhi hai** — is commit me nahi badla, kyunki iska matlab API shape badalna
hai (overview ko aggregate SQL chahiye, per-monitor rows nahi). Section
"Aage kya" me hai.

### Nahi kiya, aur wajah

| Aapke prompt me | Mera faisla | Wajah |
|---|---|---|
| `SELECT *` hatao | ❌ Nahi kiya | D1 **rows** bill karta hai, columns nahi. `SELECT * FROM monitors WHERE id = ?` primary-key lookup me 1 row padhta hai — specific columns likhne se 1 row hi padhega. Rows same, bytes kam (jo D1 bill nahi karta). 31 jagah badalna correctness ka risk hai, benefit sirf bandwidth ka |
| List queries me `LIMIT` | ⚠️ Partially | 31 me se sirf 1 unbounded thi: `SELECT * FROM notification_channels ORDER BY created_at ASC`. Channels realistically <100 hain, par unbounded hai |
| KV caching layer | ❌ Nahi kiya | Workers KV **free tier me 1,000 writes/day** hai. Dashboard 30s pe poll karta hai = 2,880 writes/day. Cache lagana **free quota turant khatam** kar dega. Ye Phase 5 ka suggestion is project pe ulta nuksan dega |
| Cron cleanup | ❌ Already hai | `sweep.ts:350` — `DELETE FROM checks WHERE checked_at < ?`, 7-din retention. Daily 3 AM UTC |

---

## Phase 4 — Indexes

### `EXPLAIN QUERY PLAN` se verified

```
-- 24h/90d aggregate
SEARCH checks USING INDEX idx_checks_monitor_time (monitor_id=? AND checked_at>?)

-- latest check per monitor
SEARCH checks USING COVERING INDEX idx_checks_monitor_time (monitor_id=?)
SEARCH c USING INDEX idx_checks_monitor_time (monitor_id=? AND checked_at=?)

-- daily rollup
SEARCH daily_status USING INDEX sqlite_autoindex_daily_status_1 (monitor_id=? AND date>?)
```

**Teeno hot queries indexed hain.** Naya index banana yahan nahi tha — ek
extra index D1 pe write cost badhata hai har INSERT pe (`checks` table me roz
5,760 inserts).

### Jo maujood hain, sahi

`idx_checks_monitor_time`, `idx_checks_time`, `idx_checks_monitor_status`,
`idx_daily_status_date`, `idx_users_email`, `idx_sessions_token`,
`idx_groups_slug`, `idx_monitors_group`, `idx_incident_updates_incident`,
`idx_audit_created` — sab zaroori queries cover karte hain.

---

## Phase 5 — Caching

**Deliberately nahi kiya.** Wajah Phase 3 table me hai — KV free tier ke
writes budget ko bust kar deta.

Jo caching **already** hai, wo sahi jagah hai:
- `Date`-based rollup `daily_status` — 1 row/monitor/day, raw history ka
  replacement
- Monitor configs request-scoped hain, Worker isolate me cached hote hain
- Client polling 30s hai, aur debounce search pe refetch rokta hai

**Jab add karna ho:** Workers **Cache API** use karo, KV nahi — Cache API
request count ke against bill hota hai, writes ke against nahi. Status page
(1 min TTL) pehle candidate hai, kyunki wo public aur high-traffic hai.

---

## Phase 6 — Cron cleanup

Already implemented, `src/worker/checkers/sweep.ts`:

| Table | Retention | Config |
|---|---|---|
| `checks` | 7 din | `RAW_CHECK_RETENTION_DAYS` |
| `daily_status` | 365 din | `DAILY_STATUS_RETENTION_DAYS` |
| `incidents` | permanent | — |
| `audit_log` | permanent | — |

`MAINTENANCE_HOUR_UTC = 3` pe chalta hai (cron har minute chalta hai, cleanup
sirf is ghante me).

**Aapke prompt me `crons = ["0 3 * * *"]` tha. Maine nahi badla** — abhi
`"* * * * *"` hai, kyunki monitor checks bhi isi cron se chalte hain. Sirf
cleanup 3 AM pe karna matlab cron frequency 144× kam kar dena, jo monitoring
ko 24 ghante me ek hit tak le aayega.

---

## Phase 7 — Query optimization

| Technique | Applied |
|---|---|
| Expensive query conditional | ✅ 90d raw scan |
| `SELECT *` → specific columns | ❌ Rows same hain, D1 bytes nahi bill karta |
| `LIMIT` on lists | ⚠️ 31 me se 1 unbounded |
| Loop → `IN` clause | ✅ Pehle se (`placeholders` pattern) |
| Parameterized queries | ✅ Sab `.bind()` / `?` use karte hain |
| Pagination | ✅ `LIMIT ? OFFSET ?` + `has_more` |
| `COUNT(*)` batching | ✅ `Promise.all` — 3 independent endpoints |

---

## Phase 8 — Usage table

### Free tier limits

| Metric | Free (daily) | Paid (monthly) |
|---|---|---|
| Rows read | 5,000,000 | 25 billion |
| Rows written | 100,000 | 50 million |
| Storage | 5 GB (account) | 5 GB, then $0.75/GB |
| Max DB size | 500 MB | 10 GB |
| Databases | 10 | 50,000 |
| Queries/Worker invocation | 50 | 1,000 |
| Time Travel | 7 din | 30 din |

### Actual usage — 20 monitors, 300s interval

| Operation | Frequency | Rows Read/Day | Rows Written/Day |
|---|---|---|---|
| Monitoring checks | 5,760/day | ~5,760 | ~5,760 |
| Dashboard loads | 100/day | ~2,400,000 | 0 |
| Status page loads | 500/day | ~250,000 | 0 |
| Cron cleanup | 1/day | ~5,760 | ~5,760 |
| **TOTAL** | | **~2,500,000** | **~11,520** |
| **Free limit** | | **5,000,000** | **100,000** |
| **% used** | | **50%** | **12%** |
| **Verdict** | | ⚠️ Warning | ✅ Safe |

> ⚠️ **Warning, Safe nahi.** 100 dashboard loads pe 50%. Aapke instance pe
> traffic badhe to seedha 5M cross ho jaayega — aur D1 silently bill karta
> hai, request fail nahi hoti.

50% pe `CHECKS_PER_RUN` kam karne se kuch nahi hota (wo writes control karta
hai). Reads sirf **Fix 2** se kam honge.

---

## Phase 9 — Verification

| Check | Result |
|---|---|
| `pnpm verify` | ✅ exit 0 |
| Tests | ✅ 163/163 (3 naye) |
| Naye tests purane code pe fail hote hain? | ✅ `actual: 2, expected: 1` |
| `EXPLAIN QUERY PLAN` | ✅ teenon hot queries indexed |
| Production pe deploy | ✅ `020b7ec6` |
| Rollup coverage verify | ✅ Live API se confirm |

Test `tests/rollup-query.test.ts` ek counting proxy D1 adapter ke aage lagata
hai aur assert karta hai ke raw scan **kitni baar** chalti hai — 2 (purana) ya
1 (naya). Boolean nahi, count — kyunki 24-hour query legitimately hamesha
chalti hai aur "koi chali ya nahi" se fix ko break dhoondh liya gaya.

---

## Aage kya — priority order

| # | Kaam | Rows/day bachega | Risk |
|---|---|---|---|
| 1 | Overview ko aggregate SQL banao (per-monitor rows nahi) | **~1,200,000** | Medium |
| 2 | Status page ko 1-min cache karo (Cache API) | ~200,000 | Low |
| 3 | `notification_channels` query me `LIMIT` | ~0 | Low |
| 4 | Dashboard polling 30s → 60s jab tab hidden ho | ~50% | Low |

**#1 sabse zyada deta hai** aur wo API shape badalta hai — isliye akele commit
mein, tests ke saath.

---

<a href="../README.md">← README</a> · <a href="CONFIGURATION.md">Configuration</a> · <a href="DEPLOYMENT.md">Deployment</a>