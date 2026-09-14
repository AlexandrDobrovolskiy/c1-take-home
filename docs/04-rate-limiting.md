# Rate limiting (tasks/rate-limiting.md)

> **Update (post-audit):** the original "req.ip is the real client" claim was wrong two ways (spoofable XFF, and browser traffic sharing one bucket). Fixed: Envoy `use_remote_address` + `trust proxy: 1`, login limited per-IP *and* per-username, failing closed when Redis is down, and the bucket clock now comes from Redis TIME so replica clock skew cannot mint tokens. See [post-audit.md](10-post-audit.md).

## Requirements → what was built

- ~5 messages / 10s, per user per conversation → **token bucket**: capacity 5, refill 0.5 tokens/s,
  key `send:{userId}:{conversationId}` (tunable via `SEND_RATE_CAPACITY` / `SEND_RATE_REFILL_PER_SEC`).
- Reject with **429 + Retry-After** → the bucket computes exactly how long until the next token
  ((cost − tokens) / rate) and returns it; the middleware sets the header. The composer UI restores
  the typed text and shows "Sending too fast — retry in Ns".
- **Per user** (and per conversation) → one noisy sender throttles neither other users in the room
  nor their own other conversations. Both verified.
- **Must hold across instances** → state lives in Redis, evaluated by an **atomic Lua script**
  (single round trip; read-refill-consume can't race concurrent requests, unlike GET-then-SET).
  Verified: a burst of 8 sends was served by three different instances and the cap still held at
  exactly 5.

## Why a token bucket (not a fixed INCR window)

A fixed window (`INCR` + `EXPIRE`) allows 2× the limit at window boundaries (5 at 0:09 + 5 at 0:11)
and gives coarse Retry-After. The bucket allows a burst up to capacity, then enforces the sustained
rate smoothly, and knows precisely when the next send becomes possible. Cost: one small Lua script
(cached via `SCRIPT LOAD`/`EVALSHA` with a `NOSCRIPT` reload fallback for Redis restarts). Bucket
keys expire at 2× drain time, so idle keys clean themselves up.

## Fail-open

If Redis is unreachable the middleware logs and lets the request through: the limiter is
protection, not a dependency worth taking message-sending down for. (Trade-off documented — for a
strict-security endpoint you might choose fail-closed.)

## Also covered: login brute force

`docs/01-auth.md` deferred login rate limiting to this task. `POST /api/auth/login` now has a per-IP
bucket (burst 10, 1 token / 2s; `LOGIN_RATE_*` to tune). Envoy sets `X-Forwarded-For` and the app
sets `trust proxy`, so `req.ip` is the real client. Verified: 12 rapid bad-password attempts → ten
401s then 429s.

## Tests

`tests/ratelimit.test.ts` (TDD): burst-then-deny with positive Retry-After, refill over time, key
independence, and atomicity — a 20-wide concurrent burst against capacity 5 admits exactly 5.

## Not covered (deliberate)

WS `subscribe` frames also hit the DB and could be limited with the same primitive; left out to
keep scope tight — the send path was the abuse vector in practice.
