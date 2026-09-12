# Authentication & authorization

## What was wrong

There was no identity layer at all: `userId`/`senderId` were client-supplied on every request, so
anyone could read any conversation, post as any user, and subscribe over WebSocket to any
conversation id. The WS hub never checked membership either.

## Design

**Login:** `POST /api/auth/login` with username + password. Passwords are hashed with **scrypt**
(Node built-in, async — runs on the libuv threadpool so login cost never blocks the event loop).
When the username doesn't exist we still verify against a dummy hash so response timing doesn't
reveal which usernames are registered.

**Session:** a **stateless HMAC-SHA256 signed token** (`base64url(payload).base64url(mac)`,
payload = `{uid, name, exp}`, 7-day TTL) set as an **httpOnly, SameSite=Lax cookie**.

Why this shape, given the "fast, high-load, horizontally scalable" requirement:

- **Zero I/O per request.** Verification is one HMAC (~µs of CPU). No session store lookup on the
  hot path — unlike Redis-backed sessions, per-request auth cost doesn't grow with load and adds no
  network round-trip.
- **Scales to N instances for free.** Any instance holding `AUTH_SECRET` (env) can verify any
  token. No sticky sessions, no shared session state — this composes directly with the
  multi-instance task.
- **Cookie authenticates HTTP *and* WebSocket.** The httpOnly cookie rides along on the WS upgrade
  request, so sockets are authenticated at connect time with the same token — no token juggling in
  JS, and XSS cannot read the credential.
- **No new dependencies.** Node `crypto` covers scrypt, HMAC, and constant-time comparison
  (`timingSafeEqual`).

**Authorization:** identity now comes only from the token, never the request body/query.

- `GET /api/conversations` — lists only the token user's conversations.
- `POST/GET /api/messages` — sender is `req.user.uid`; membership enforced via a PK lookup on
  `conversation_participants` (O(1), cacheable in Redis later if it ever dominates).
- WS `subscribe` — requested conversation ids are intersected with the user's actual memberships;
  unauthenticated sockets are closed with code 4401.
- `POST /api/conversations` — creator is always a participant; invitees are resolved by username so
  clients never pass raw user ids. Conversation + participants insert is now transactional.

## Trade-offs & deliberate omissions

- **No revocation before expiry** — the price of statelessness. If needed: short-lived tokens +
  refresh, or a small Redis denylist checked only on sensitive routes. Logout just clears the cookie.
- **CSRF:** `SameSite=Lax` covers the JSON API (all mutations are POST with JSON bodies; no
  cross-site form can produce them). A same-site-only check on `Origin` would be the next layer.
- **No login rate limiting yet** — belongs with the rate-limiting task (Redis token bucket), which
  should cover `/api/auth/login` as well as message sends.
- **`ws://` in the client** — behind TLS termination this must become `wss://` + `Secure` cookies;
  out of scope for the docker-compose dev setup.
- Demo seed users (`alice`/`bob`/`carol`, password `demo`) are precomputed scrypt hashes in
  `docker/db/mysql.sql`; there's a `hashPassword()` helper for future signup.

## Fixed alongside (small, related)

- **Express 4 async crash:** rejected promises in async handlers were unhandled rejections (process
  death on modern Node). Added a `wrap()` helper + central JSON error middleware.
- **Stored XSS:** conversation titles were rendered with `innerHTML`; now `textContent`.
- **Input hardening:** message body capped at 4000 chars, title at 200, `clientId` truncated to the
  column width, WS frames capped at 64 KiB.
