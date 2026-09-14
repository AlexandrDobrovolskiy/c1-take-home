# Typing indicator (tasks/typing-indicator.md)

## Design

Typing is an **ephemeral event on the existing Redis fan-out bus** — same path as messages, minus
persistence. The client sends `{type:'typing', conversationId}` over its WebSocket while composing;
the hub validates and re-broadcasts `{type:'typing', conversationId, userId, username}` to every
subscribed socket on every instance. Nothing is stored anywhere: state lives only in each client's
memory with a 3-second TTL.

Decisions:

- **Authorization is free.** A socket's `subs` set only ever contains membership-verified
  conversation ids (built during `subscribe`), so `ws.subs.has(conversationId)` *is* the check —
  no DB hit on this hot path. Spoofing typing into a conversation you're not in is silently
  dropped (covered by the e2e test).
- **Throttled at both ends.** Client sends at most one frame per 2s while typing; the server keeps
  a per-socket per-conversation 1s guard so a hostile client can't use the bus as an amplifier.
  The 2s resend beats the 3s expiry, so the indicator stays lit during continuous typing and fades
  ~1–3s after it stops. A user's own message clears their indicator immediately.
- **Self-filtering on the client** (`username === me.username`) — the bus delivers uniformly to
  everyone including the sender; the sender's UI just doesn't render itself.
- **Two surfaces**, like Telegram: an italic "`bob is typing…`" line above the composer for the
  open conversation ("alice, bob are typing…" for several), and a small "`typing…`" hint on
  sidebar rows for other conversations.

## Why no rate-limit bucket or DB here

Each typing frame costs one Redis PUBLISH and some socket writes — no MySQL/Mongo. The in-memory
per-socket throttle bounds it at 1 msg/s per conversation per connection, which is cheaper than a
Redis-bucket check would be. If typing ever needed cross-feature limits, the `rateLimit` primitive
is there.

## Verification

- `tests/e2e/typing.mjs` (run: `docker compose exec api node tests/e2e/typing.mjs`) against the
  3-replica stack: bob sees alice typing in their shared conversation; carol — not subscribed —
  sees nothing; bob's spoofed typing into carol's conversation is dropped. PASS.
- Browser: with alice's tab open, bob typing showed as the composer line in the open conversation
  and carol typing showed as a sidebar hint on "Design sync" — both fading ~3s after frames stop.
