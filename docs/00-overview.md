# Overview — start here

This is the entry point to everything that changed in this take-home, why, and how to see it
working. Each area has a deeper write-up in this folder; `spec/assessment.md` holds the initial
bug hunt and plan the work followed. After feature-complete, a five-role audit panel reviewed the
result — findings in [audit.md](09-audit.md), remediation in [post-audit.md](10-post-audit.md). The
biggest post-audit change: **messages live in MySQL only** (single atomic store, FULLTEXT search);
MongoDB is gone from the stack.

### Read in order

The files in this folder are numbered in reading order — roughly the order the work happened.

0. **[Overview](00-overview.md)** (this file) — map + quick start + headline results
1. [Authentication & authorization](01-auth.md) — the first and load-bearing change
2. [Bug fixes](02-fixes.md) — event-loop blocker, idempotency, N+1/index, pagination, WS resilience
3. [Multi-instance](03-multi-instance.md) — Redis pub/sub delivery bus
4. [Rate limiting](04-rate-limiting.md) — distributed token bucket
5. [Search](05-search.md) — unified chat + message search
6. [Typing indicator](06-typing-indicator.md) — ephemeral events on the bus
7. [Load testing](07-load-testing.md) — k6 on an isolated stack + autoscaler
8. [Observability](08-observability.md) — Prometheus + Grafana dashboard
9. [Audit](09-audit.md) — five-role review panel findings
10. [Post-audit remediation](10-post-audit.md) — what the audit changed, what remains open

(`spec/assessment.md` is the pre-work bug hunt; read it before doc 1 for the "before" picture.)

## Quick start for a reviewer

```bash
cp .env.example .env
docker compose up --build        # app on :3000 (3 api replicas), Grafana on :3001
```

- **App**: <http://localhost:3000> — demo users `alice` / `bob` / `carol`, password `demo`.
- **Live dashboard**: `./tools/open-dashboard.sh` → <http://localhost:3001/d/relay>.
- **Tests** (31 — service integration + HTTP auth enforcement; the headline fixes were built
  test-first): `docker compose exec api npm test`
- **E2E** (multi-instance fan-out, typing): `docker compose exec api node tests/e2e/fanout.mjs`
  and `.../typing.mjs`
- **Load test with live dashboard + autoscaler** (isolated stack, one command):
  `npm run load-test` — or `PEAK=6000 npm run load-test` to watch it scale 2→6.
  Tear down with `npm run load-test:down`. Dashboards: `npm run dashboard` (dev stack) /
  `npm run dashboard:load` (load stack).

## What was broken → fixed (details: [fixes.md](02-fixes.md), [auth.md](01-auth.md))

| # | Defect | Fix |
|---|--------|-----|
| 1 | No auth/authz at all — client-supplied identity, WS open to anyone | Stateless HMAC token in httpOnly cookie (scrypt login), membership enforced on send/read/WS subscribe |
| 2 | `pbkdf2Sync` blocked the event loop ~20ms per send (~392ms under 20 concurrent) | Removed (it wasn't a real signature); sends 40ms → 7ms |
| 3 | Client retries created duplicate messages | `UNIQUE (conversation_id, client_id)` + return-original on conflict; client reuses the clientId on retry |
| 4 | Express 4 async errors crashed the process | `wrap()` + central JSON error middleware |
| 5 | Stored XSS via conversation title | `textContent` |
| 6 | N+1 inbox queries + no index on messages | One `LEFT JOIN LATERAL` query + `(conversation_id)` index — covering-index plan |
| 7 | Unbounded history fetch | Cursor pagination (`before` = message id) |
| 8 | Dead WS peers leaked; dropped clients went silent | Server ping/pong heartbeat; client reconnect with backoff + resync |
| 9 | Seed wiped all message bodies on every `compose up` | Seed only populates an empty store |

## Features (all four tasks)

- **Multi-instance** ([multi-instance.md](03-multi-instance.md)) — Redis pub/sub delivery bus, one
  uniform path, graceful local-only degradation; 3 replicas behind Envoy verified by e2e.
- **Rate limiting** ([rate-limiting.md](04-rate-limiting.md)) — distributed token bucket (atomic Lua
  in Redis), per user *per conversation*, 429 + precise `Retry-After`; holds across replicas
  (verified: a burst served by three instances still capped exactly). Login brute-force limiter
  included.
- **Search** ([search.md](05-search.md)) — Telegram-style: one query returns matching chats +
  messages (Mongo text index, scoped substring fallback), authorization inside the query,
  search-as-you-type UI with jump-to-message.
- **Typing indicator** ([typing-indicator.md](06-typing-indicator.md)) — ephemeral events on the same
  Redis bus, zero-DB authorization via the socket's verified subscriptions, throttled both ends.

## Beyond the tasks

- **Observability** ([observability.md](08-observability.md)) — provisioned Prometheus + Grafana;
  replicas discovered via DNS (autoscaled replicas appear automatically), 14-panel dashboard
  (latency percentiles, per-replica CPU/memory, scaling events, limiter rejections, k6 overlay).
- **Load testing** ([load-testing.md](07-load-testing.md)) — k6 against an isolated stack;
  write-path throughput measured with three-way integrity reconciliation (k6 201s == MySQL rows ==
  Mongo bodies, exact match at every rate tested).
- **Autoscaler** (`tools/autoscaler.mjs`) — HPA-style proportional CPU scaler for compose;
  verified live scaling 2→3→5→6 under a 6,000 sends/s ramp with 99.87% processed.

## Load-test results (read as shape, not gospel — single 18-core host, co-located generator)

- Send pipeline (limiter → membership → atomic MySQL insert → Redis publish → WS fan-out):
  **p95 3–7ms** at 600–3,000 sends/s; **6,000 sends/s peak** absorbed at 6 replicas
  (p95 21ms, 0.12% failures, zero 5xx, ≈19k WS deliveries/s). Numbers were measured pre-migration
  against the dual-store pipeline; methodology caveats in load-testing.md.
- Reads: inbox p95 1.4ms, history p95 2.6ms, search p95 4.8ms at ~3,100 req/s mixed load
  (closed-model pacing — see the caveat note in load-testing.md).
- Rate limiter: ~2,700 rejections/s sustained.

## Known limitations / what I'd do next

- **No event-gap detection** beyond the resubscribe refetch: a Redis outage means missed realtime
  for remote clients until the heartbeat closes their sockets (≤30s). Next: per-conversation
  sequence checks or Redis Streams.
- **Token revocation** before expiry isn't possible (stateless trade-off, documented in auth.md).
- **Single Redis** is the eventual bottleneck for pub/sub + limiting; sharding path sketched in
  multi-instance.md.
- **TLS** (`wss://`, `Secure` cookies) assumed to live at a terminating proxy in front.
- Reactive autoscaling keeps a ~10–15s under-provisioned window on sharp ramps (p99-only spike);
  headroom or predictive scaling would close it.
- No signup, message edit/delete, delivery acks, or forward pagination from a search hit —
  see audit.md P4 / post-audit.md "Still open".
