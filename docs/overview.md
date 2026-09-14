# Overview — start here

This is the entry point to everything that changed in this take-home, why, and how to see it
working. Each area has a deeper write-up in this folder; `spec/assessment.md` holds the initial
bug hunt and plan the work followed.

## Quick start for a reviewer

```bash
cp .env.example .env
docker compose up --build        # app on :3000 (3 api replicas), Grafana on :3001
```

- **App**: <http://localhost:3000> — demo users `alice` / `bob` / `carol`, password `demo`.
- **Live dashboard**: `./tools/open-dashboard.sh` → <http://localhost:3001/d/relay>.
- **Tests** (20, all TDD'd with the fixes/features): `docker compose exec api npm test`
- **E2E** (multi-instance fan-out, typing): `docker compose exec api node tests/e2e/fanout.mjs`
  and `.../typing.mjs`
- **Load test with live dashboard + autoscaler** (isolated stack, one command):
  `./tools/load-test.sh` — or `PEAK=6000 ./tools/load-test.sh` to watch it scale 2→6.
  Tear down with `./tools/load-test.sh down`.

## What was broken → fixed (details: [fixes.md](fixes.md), [auth.md](auth.md))

| # | Defect | Fix |
|---|--------|-----|
| 1 | No auth/authz at all — client-supplied identity, WS open to anyone | Stateless HMAC token in httpOnly cookie (scrypt login), membership enforced on send/read/WS subscribe |
| 2 | `pbkdf2Sync` blocked the event loop ~20ms per send (~392ms under 20 concurrent) | Removed (it wasn't a real signature); sends 40ms → 7ms |
| 3 | Client retries created duplicate messages | `UNIQUE (conversation_id, client_id)` + return-original on conflict; concurrent-safe |
| 4 | Express 4 async errors crashed the process | `wrap()` + central JSON error middleware |
| 5 | Stored XSS via conversation title | `textContent` |
| 6 | N+1 inbox queries + no index on messages | One `LEFT JOIN LATERAL` query + `(conversation_id)` index — covering-index plan |
| 7 | Unbounded history fetch | Cursor pagination (`before` = message id) |
| 8 | Dead WS peers leaked; dropped clients went silent | Server ping/pong heartbeat; client reconnect with backoff + resync |
| 9 | Seed wiped all message bodies on every `compose up` | Seed only populates an empty store |

## Features (all four tasks)

- **Multi-instance** ([multi-instance.md](multi-instance.md)) — Redis pub/sub delivery bus, one
  uniform path, graceful local-only degradation; 3 replicas behind Envoy verified by e2e.
- **Rate limiting** ([rate-limiting.md](rate-limiting.md)) — distributed token bucket (atomic Lua
  in Redis), per user *per conversation*, 429 + precise `Retry-After`; holds across replicas
  (verified: a burst served by three instances still capped exactly). Login brute-force limiter
  included.
- **Search** ([search.md](search.md)) — Telegram-style: one query returns matching chats +
  messages (Mongo text index, scoped substring fallback), authorization inside the query,
  search-as-you-type UI with jump-to-message.
- **Typing indicator** ([typing-indicator.md](typing-indicator.md)) — ephemeral events on the same
  Redis bus, zero-DB authorization via the socket's verified subscriptions, throttled both ends.

## Beyond the tasks

- **Observability** ([observability.md](observability.md)) — provisioned Prometheus + Grafana;
  replicas discovered via DNS (autoscaled replicas appear automatically), 14-panel dashboard
  (latency percentiles, per-replica CPU/memory, scaling events, limiter rejections, k6 overlay).
- **Load testing** ([load-testing.md](load-testing.md)) — k6 against an isolated stack;
  write-path throughput measured with three-way integrity reconciliation (k6 201s == MySQL rows ==
  Mongo bodies, exact match at every rate tested).
- **Autoscaler** (`tools/autoscaler.mjs`) — HPA-style proportional CPU scaler for compose;
  verified live scaling 2→3→5→6 under a 6,000 sends/s ramp with 99.87% processed.

## Headline numbers (single 18-core host, everything sharing it)

- Send pipeline (limiter → membership → MySQL → Mongo → Redis publish → WS fan-out):
  **p95 3–7ms** at 600–3,000 sends/s; **6,000 sends/s peak** absorbed at 6 replicas
  (p95 21ms, 0.12% failures, zero 5xx, ≈19k WS deliveries/s).
- Reads: inbox p95 1.4ms, history p95 2.6ms, search p95 4.8ms at ~3,100 req/s mixed load.
- Rate limiter: ~2,700 rejections/s sustained without breaking a sweat.

## Known limitations / what I'd do next

- **MySQL+Mongo dual write** isn't atomic — mitigated (retry heals bodies, reconciliation verified
  no drift under load), but the honest fix is one store or an outbox.
- **Token revocation** before expiry isn't possible (stateless trade-off, documented).
- **Single Redis** is the eventual bottleneck for pub/sub + limiting; sharding path sketched in
  multi-instance.md.
- **TLS** (`wss://`, `Secure` cookies) assumed to live at a terminating proxy in front.
- Reactive autoscaling keeps a ~10–15s under-provisioned window on sharp ramps (p99-only spike);
  headroom or predictive scaling would close it.
