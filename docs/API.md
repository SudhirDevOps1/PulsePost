# API Reference

Saare endpoints `/api` prefix ke neeche hain, JSON bolte hain, aur
same-origin browser requests auth cookie se chalte hain.

---

## Authentication

Sabse pehle login karo — session cookie set ho jaati hai:

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "you@example.com", "password": "…" }
```

```json
{ "user": { "id": "…", "email": "…", "role": "admin", "totp_enabled": false } }
```

Iske baad har request me `Cookie: pulsepost_session=…` jaata hai.

```bash
# Example: cookie jar ke saath
curl -c cookies.txt -X POST https://your-worker.workers.dev/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'

curl -b cookies.txt https://your-worker.workers.dev/api/monitors
```

### Roles

| Role | Kya kar sakta hai |
|---|---|
| `admin` | Sab — including users aur channels delete |
| `editor` | Monitors, groups, incidents, channels create/update |
| `viewer` | Sirf padhna |

Ek endpoint ka required role uske table me likha hai.

---

## Response shape

Sab kuch ek envelope me:

```json
{ "monitors": [ … ] }
{ "monitor": { … } }
{ "error": "human readable", "code": "CONFLICT" }
```

Error codes: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `RATE_LIMITED`, `INTERNAL`.

---

## Auth

| Method | Path | Role | Kya karta hai |
|---|---|---|---|
| `GET` | `/api/auth/status` | — | Setup complete hua ya nahi, logged-in ya nahi |
| `POST` | `/api/auth/setup` | — | **Ek hi baar.** Pehla admin banata hai |
| `POST` | `/api/auth/login` | — | Session banata hai |
| `POST` | `/api/auth/logout` | — | Session delete karta hai |
| `GET` | `/api/auth/me` | viewer | Current user |
| `PATCH` | `/api/auth/profile` | viewer | Naam/profile update |
| `POST` | `/api/auth/password` | viewer | Password change |

### `GET /api/auth/status`

```json
{ "needs_setup": false, "authenticated": true, "auth_mode": "password" }
```

App boot par yeh chalti hai — isliye lightweight hai.

### `POST /api/auth/setup`

```json
{ "email": "admin@example.com", "password": "strong-passphrase", "name": "Admin" }
```

Sirf tab 201 deti hai jab instance pe koi user na ho. Baad me `409 CONFLICT`.
Rate-limited hai — brute force se bachne ke liye.

---

## Monitors

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/monitors` | viewer |
| `GET` | `/api/monitors/overview` | viewer |
| `GET` | `/api/monitors/edge` | viewer |
| `GET` | `/api/monitors/:id` | viewer |
| `POST` | `/api/monitors` | editor |
| `PATCH` | `/api/monitors/:id` | editor |
| `DELETE` | `/api/monitors/:id` | admin |
| `POST` | `/api/monitors/:id/check` | viewer |

### `GET /api/monitors`

Sab query params server-side hain, to search/sort/paging list size se independent
kaam karta hai.

| Param | Default | Range | Note |
|---|---|---|---|
| `group` | — | UUID | Group filter |
| `status` | — | `up`\|`degraded`\|`down` | |
| `active` | — | `true`\|`false` | Paused monitors alag |
| `q` | — | **max 48 chars** | Naam ya URL, case-insensitive |
| `sort` | `created_at` | `name`\|`created_at`\|`updated_at` | Whitelist only |
| `order` | `desc` | `asc`\|`desc` | |
| `limit` | `50` | max `200` | |
| `offset` | `0` | ≥ 0 | |
| `include_latency` | `false` | | Sparkline points, extra query |
| `include_uptime` | `false` | | 90-day `daily` array |

> **`q` 48 characters tak hai, iska technical reason hai.** D1 ka `LIKE` pattern
> 50 bytes tak process karta hai. Longer pattern silently match karna chhodh
> deta hai, to schema validation ne ise pehle hi rok diya — runtime pe
> unpredictable behaviour se behtar.

```json
{
  "monitors": [ { "id": "…", "name": "Checkout", "current_status": "up", "uptime_24h": 99.98, "…": "…" } ],
  "limit": 50, "offset": 0, "has_more": false
}
```

`has_more` ek `COUNT(*)` bachata hai — `limit` rows return hue ya nahi, se pata
chal jaata hai.

### `POST /api/monitors`

```json
{
  "name": "Checkout API",
  "url": "https://api.example.com/health",
  "method": "GET",
  "interval_seconds": 300,
  "timeout_ms": 10000,
  "expected_status_min": 200,
  "expected_status_max": 299,
  "latency_warn_ms": 400,
  "latency_fail_ms": 2000,
  "group_id": "…"
}
```

DSL monitors ke liye `"kind": "dsl"` aur `"script": "…", "url": null`.

> **URL dobara validate hota hai**, Zod ke baad bhi. Schema *shape* check karta
> hai; SSRF guard *reachability* check karta hai. Sirf wahi guard ek URL ko
> store karna safe banata hai.

### `POST /api/monitors/:id/check`

Turant ek check chalta hai aur result deta hai. Cron ke wait kiye bina test karne
ke liye.

---

## Groups

Groups **hi** public status pages define karte hain — alag entity nahi.

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/groups` | viewer |
| `GET` | `/api/groups/:id` | viewer |
| `POST` | `/api/groups` | editor |
| `PATCH` | `/api/groups/:id` | editor |
| `DELETE` | `/api/groups/:id` | admin |

```json
{ "name": "Public API", "slug": "api", "description": "Customer-facing", "is_public": true }
```

`slug` se status page URL banta hai — `/status/api`.

---

## Incidents

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/incidents` | viewer |
| `GET` | `/api/incidents/:id` | viewer |
| `POST` | `/api/incidents` | editor |
| `PATCH` | `/api/incidents/:id` | editor |
| `DELETE` | `/api/incidents/:id` | admin |

Status progression: `investigating` → `identified` → `monitoring` → `resolved`.
`resolved_at` status set hote hi derive hota hai.

---

## Notification channels

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/channels` | viewer |
| `POST` | `/api/channels` | editor |
| `DELETE` | `/api/channels/:id` | admin |
| `POST` | `/api/channels/:id/test` | editor |
| `DELETE` | `/api/channels/:id/link/:monitorId` | editor |

### `POST /api/channels`

```json
{ "type": "slack", "name": "Ops Slack", "url": "https://hooks.slack.com/services/…" }
```

Types: `slack`, `discord`, `webhook`.

> **URL write-only hai.** Store to hota hai, par `GET /api/channels` kabhi
> return nahi karta — response me `{"url":"****"}` aata hai. Isiliye edit karte
> waqt blank chhodna matlab "URL wahi rakho" hai.

### `POST /api/channels/:id/test`

Ek sample alert bhejta hai — config verify karne ke liye bina real incident
create kiye.

---

## Users

| Method | Path | Role |
|---|---|---|
| `GET` | `/api/users` | admin |
| `POST` | `/api/users` | admin |
| `PATCH` | `/api/users/:id` | admin |
| `DELETE` | `/api/users/:id` | admin |
| `POST` | `/api/users/:id/totp/start` | admin |
| `POST` | `/api/users/:id/totp/disable` | admin |
| `POST` | `/api/users/:id/password` | admin |

Users list me **kabhi password hash nahi jaata**. TOTP seed bhi nahi — sirf
`totp_enabled` boolean.

---

## Public endpoints

Login ke bina. Inpe rate limit zyada hai.

| Method | Path | Kya hai |
|---|---|---|
| `GET` | `/api/health` | Liveness + DB latency |
| `GET` | `/api/status` | Saare public status pages |
| `GET` | `/api/status/:slug` | Ek status page |
| `GET` | `/api/public/incidents` | Public incidents |

### `GET /api/health`

```json
{
  "ok": true,
  "database": { "provider": "d1", "dialect": "sqlite", "latency_ms": 148 },
  "version": "1.0.0",
  "environment": "production"
}
```

### `GET /api/status/:slug`

Status page ka poora data — monitors, uptime history, incidents.

---

## Rate limits

| Scope | Limit |
|---|---|
| Auth endpoints | Login/setup ke liye tight — brute force ke liye |
| General API | Standard |

429 pe `Retry-After` header aata hai.

---

## Errors

```json
{ "error": "Monitor not found", "code": "NOT_FOUND" }
```

Sab errors yehi shape. Validation failures me per-field detail aata hai.

---

<a href="DEPLOYMENT.md">← Deployment</a> · <a href="CONFIGURATION.md">Configuration</a> · <a href="../README.md">README</a>