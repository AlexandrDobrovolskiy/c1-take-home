# Load testing & autoscaling

## Tool and method

**k6** (Grafana): scenarios scripted in JS to match the stack, built-in latency percentiles and
pass/fail thresholds, WebSocket support for the realtime path, runs as a container.

**Isolated environment**: a second compose project (`-p relay-load` +
`docker-compose.loadtest.yml`) — its own MySQL/Mongo/Redis/Envoy/api replicas on a private network,
no published ports colliding with dev (Envoy exposed on 3100 for debugging only). k6 joins the
network and hits `envoy:3000` directly. The dev stack and its data are never touched.

**Data**: `tests/load/seed.mts` bulk-seeds 50 users, 20 conversations, 10,000 messages
(word-seeded bodies so search does real work). The only config deviation from production defaults
is the *login* limiter (the load generator is one IP; per-IP login limits throttle test setup, not
anything measured). Send/search limits stay at production values deliberately.

**Scenarios** (`tests/load/k6.js`):
- `reads` — inbox + history page + 15% search, ramping to 100 VUs (300 in `HEAVY=1`)
- `sends` — 20 VUs sending within the rate limit (exercises MySQL+Mongo writes and Redis fan-out)
- `abuse` — 5 VUs hammering one user's sends with zero pacing: the limiter must answer 429, never 5xx
- `sockets` — 100 persistent WebSocket subscribers receiving fan-out throughout

## Results

**Baseline — 3 replicas, ~3,100 req/s sustained, 407k requests:**

| endpoint        | med     | p95     | p99     |
|-----------------|---------|---------|---------|
| inbox listing   | 0.76 ms | 1.4 ms  | 2.4 ms  |
| history page    | 1.6 ms  | 2.6 ms  | 3.4 ms  |
| search          | 3.4 ms  | 4.8 ms  | 6.1 ms  |
| send            | 3.1 ms  | 5.9 ms  | 40 ms   |

0 failed requests; 100% of 407k checks; all 200 WS sessions upgraded and receiving; the abuse
scenario alone pushed ~2,700 rejections/s through the Redis limiter with zero 5xx.

**HEAVY — started on 2 replicas with the autoscaler active; peak 420 VUs, 456k requests:**

- 0 failed requests, 100% of 456k checks, all thresholds passed
- Latencies flat vs baseline (inbox p95 1.33 ms, history p95 2.6 ms, send p95 5.5 ms)
- 300 WS sessions held; paced sends 99% success (the misses were 429s from send-VU/user collisions,
  i.e. the limiter working)
- No container restarts, no OOM kills (verified via `docker inspect` RestartCount/OOMKilled)

## Autoscaler (`tools/autoscaler.mjs`)

Why it's relevant here: Node is single-threaded — one replica saturates at ~1 core — so horizontal
replicas on a multicore host add real capacity. And the architecture already supports elastic
membership: Envoy `STRICT_DNS` re-resolves replicas every few seconds, the Redis bus fans events to
whoever exists, stateless auth means any replica serves any request, and on scale-in dropped WS
clients auto-reconnect to survivors. The script is the compose-level equivalent of a k8s HPA:
average per-replica CPU via `docker stats`, scale up fast (2 ticks > 70%), scale down slow
(6 ticks < 25%), cooldown between actions, min 2 / max 6.

Observed lifecycle during the HEAVY run:

```
replicas=2 avgCpu=16.5%        # ramp begins
replicas=2 avgCpu=79.4%        # abuse + spike phase
scaling api -> 3 (cpu 79% > 70%)
replicas=3 avgCpu=19–29%       # pressure absorbed
replicas=3 avgCpu=0.3%         # load ended
scaling api -> 2 (cpu 0% < 25%)  # after 6 quiet ticks, floor at MIN=2
```

The key evidence: the scale-up happened **mid-run** and the run still recorded **zero failed
requests** — replica discovery and traffic redistribution are seamless.

## Honest caveats

- Single-host test: all replicas share one machine's cores, RAM and disk, and the load generator
  ran on the same machine — absolute numbers flatter the real world; the *shape* (flat latency
  under 3x VU growth, graceful 429s, clean scale events) is the signal.
- The CPU thresholds (70/25) were chosen for a demonstrable cycle; production would tune against a
  latency SLO with longer stabilization windows (during load, 3-replica CPU hovered near the
  scale-down threshold — a real HPA's stabilization window exists precisely to avoid flapping).
- Not yet bottlenecked: at these rates MySQL pool (10 conns/replica), Mongo, and Redis all stayed
  comfortable. The first real ceiling is likely the single Redis for pub/sub + rate limiting;
  the docs in multi-instance.md sketch the sharding path.
