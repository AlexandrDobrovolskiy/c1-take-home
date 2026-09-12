# Multi-instance (tasks/multi-instance.md)

## What broke with >1 instance

The WS hub kept its connected sockets in an in-process `Set`. Envoy happily round-robins HTTP
across replicas, so a message POSTed to instance A was only broadcast to sockets *connected to A* —
everyone connected to B or C got nothing (no new messages, no unread dots).

Everything else was already instance-agnostic by the time this task started, deliberately so:

- **Auth** is a stateless HMAC token — any instance holding `AUTH_SECRET` verifies any request; no
  sticky sessions, no shared session store.
- **All persistent state** lives in MySQL/Mongo; idempotency (`clientId`) is enforced by a DB
  unique index, so concurrent duplicate sends converge even when they land on different instances.

## Design: Redis pub/sub as the delivery bus

`broadcast()` now publishes `{conversationId, payload}` to one Redis channel (`relay:events`);
every instance subscribes at startup and delivers each event to *its own* sockets that are
subscribed to that conversation.

Decisions and why:

- **Pub/sub over sticky sessions.** Stickiness (e.g. hashing on a cookie) only pins a client to an
  instance — it does nothing for cross-instance conversations, which is the actual problem. The bus
  solves delivery regardless of where sockets or senders land.
- **One uniform delivery path.** The publishing instance does *not* short-circuit to its local
  sockets; it too delivers on pub/sub receipt. One code path, no double-delivery edge cases, and
  local delivery is exercised by every message rather than only in cross-instance cases.
- **Graceful degradation.** If the publish fails (Redis down), we log and fall back to local-only
  delivery — clients on other instances catch up via the reconnect/resync path, and the message
  itself is already durable in MySQL/Mongo before broadcast.
- **Single channel, filter locally.** Every instance receives every event and filters against its
  sockets. At this scale that's the right trade: trivial to reason about, no subscribe/unsubscribe
  churn, no refcounting bugs. When event volume × instance count makes that wasteful, the natural
  next steps are per-conversation channels (subscribe only to conversations with local sockets) or
  Redis Streams if replay/at-least-once matters. Pub/sub is fire-and-forget by design — fine here,
  because history is DB-backed and clients resync on reconnect.
- **Two Redis connections** (`pub` + `sub`): a connection in subscriber mode can't issue regular
  commands. node-redis auto-reconnects and re-subscribes after a drop.

## Operational bits

- `docker-compose.yml` sets `deploy: replicas: 3` for `api`; `docker compose up -d --scale api=N`
  also works. Envoy's `STRICT_DNS` + `ROUND_ROBIN` picks up all replica IPs from Docker DNS.
- Every HTTP response carries `X-Instance` (container hostname) for observability.
- Seeding runs as a separate one-shot service, so N replicas don't race the seed.

## Verification

`tests/e2e/fanout.mjs` (run: `docker compose exec api node tests/e2e/fanout.mjs`) against 3
replicas:

```
round-robin: 3 distinct instances over 12 requests [261221c1bc65, 3ca62a254b2c, 4784189c9ec3]
message posted via instance 261221c1bc65
client-0..3: received            <- 4 sockets spread across instances
PASS: all 4 sockets received the message
```

It also fails loudly if all traffic hits one instance (i.e. the stack isn't actually scaled), so it
can't silently pass on a single-instance setup. The unit suite (11 tests) still passes.
