# Security

PulsePost khud ko internet par expose karta hai — wo iska kaam hai. Is liye
security assumptions yahan likhi hain taaki aap jaan sakein kya kya guard hai,
kya kya nahi, aur apna instance kaise harden karein.

---

## Reporting a vulnerability

Please public issue ke bajaye private tareeke se report karein. Details
`package.json` ke `repository` field mein diye hain.

Include karein: kya expect kar rahe the, kya hua actually, steps to reproduce.
Public disclosure se pehle fix deploy karne ka time dena.

---

## Authentication

**Passwords.** PBKDF2-SHA256, per-user random salt. Plaintext password kabhi
store nahi hota aur kisi response mein return nahi hota.

**Sessions.** Sirf SHA-256 hash store hota hai, raw token nahi. Iska matlab
database leak hone par bhi attacker ke paas usable session cookie nahi hoga —
sirf unhone jo already expire ho chuke hain.

Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, aur `__Host-` prefix
(jis se browser domain/path inject nahi kar sakta).

**TOTP.** RFC 6238, WebCrypto pe implement — koi OTP library dependency nahi.
Seed **at rest encrypted** hota hai, `TOTP_SECRET` se AES-256-GCM.

> `TOTP_SECRET` set ke bina TOTP enrol karna refuse ho jata hai. Iska deliberate
> fallback nahi hai: ek built-in key public hoti, to wo koi encryption nahi hoti.

**Roles.** `admin` / `editor` / `viewer`. Do invariants enforce hote hain:

1. **Aakhri admin ko demote ya disable nahi kar sakte.** Warna instance se
   lockout ho jayega aur recover karne ke liye shell chahiye.
2. **Apne se upar wale account ko edit nahi kar sakte.** Warna ek `viewer`
   API se khud ko `admin` bana sakta tha.

---

## SSRF protection

Monitor URLs server se fetch hoti hain — ye classic SSRF vector hai. Guard
`src/worker/checkers/ssrf.ts` mein hai aur block karta hai:

- Loopback, private (RFC 1918), link-local, CGNAT ranges
- IPv4-mapped IPv6 addresses (bypass vector)
- Localhost aliases jaise `localtest.me`
- DNS **dobara resolve** karke — pehle check karo, phir fetch ke waqt
  redirect ho to **dobara validate**

Default **ON** hai, har jagah.

`ALLOW_PRIVATE_TARGETS = "true"` se off hota hai — sirf tab jab aap jaanbujh
kar localhost/private targets monitor karna chahte hain (Docker use case).
Yeh kabhi `ENVIRONMENT` se infer nahi hota.

> Local testing ke liye ise on karna padega. Production mein ise off rakhein.

---

## Webhook URLs

Notification channel URLs aksar secret contain karte hain
(`hooks.slack.com/services/T…/B…/xxx`).

- Write-only: store hote hain, **kabhi kisi GET se return nahi hote**
- List endpoint sirf batata hai ki URL configured hai ya nahi
- Audit log mein bhi URL log nahi hota

---

## Rate limiting

Cloudflare ke native rate limiter pe — application code mein koi counter nahi.

| Binding | Limit | Applies |
|---|---|---|
| `RATE_LIMITER_AUTH` | 10 / 60s | Login, setup, TOTP, outbound test calls |
| `RATE_LIMITER_API` | 300 / 60s | Baaki authenticated API |

`/api/cron` alag se `CRON_SECRET` se protected hai (HMAC constant-time compare),
taaki koi aapke monitors ke liye free amplification vector na bana sake.

---

## Input validation

Har input Zod schema se guzarta hai. Object schemas `.strict()` hain — unknown
keys reject hoti hain, silently ignore nahi.

Ek specific case jo pehle bug tha: `updateIncidentSchema` mein `group_id`
`.nullable()` tha par `.optional()` nahi, jisse har PATCH ke saath group_id
bhejna mandatory ho gaya tha.

---

## Security headers

Har response par:

- `Content-Security-Policy` — `script-src 'self'` (koi `'unsafe-inline'` ya
  `'unsafe-eval'` nahi), `frame-ancestors 'none'`, `object-src 'none'`
- `Strict-Transport-Security` — production mein (`max-age=63072000`)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cache-Control: no-store` — API responses

---

## Hardening checklist

Deploy ke baad ye kar lein:

1. **Default password turant badlein.** Setup screen pe jo bhi password diya
   use change karein.
2. **`ADMIN_IP_ALLOWLIST` set karein** agar aapke users limited hain.
   Comma-separated IPs ya CIDR ranges.
3. **`ALLOW_PRIVATE_TARGETS` off rakhein** production mein.
4. **`CRON_SECRET` strong rakhein:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
5. **`TOTP_SECRET` set karein** agar 2FA use karna hai.
6. **Secrets `wrangler secret put` se**, kabhi `wrangler.toml` mein nahi.

---

## Threat model — kya cover nahi hai

Honesty ke liye — ye project ye **nahi** karta:

- **TLS termination** Cloudflare ka kaam hai; Worker ke peeche plaintext hai.
- **DDoS protection** edge rate limiting tak limited hai; ek distributed
  attack ko ye app-layer par pura nahi rokega.
- **Encryption at rest** database provider par depend karta hai. TOTP seeds
  khud encrypt hote hain, baaki columns provider ki responsibility hai.
- **Secret scanning** CI mein nahi hai. Agar public repo mein koi credential
  push ho gaya to wo history mein rahega — `git filter-repo` se purge karna
  padega.