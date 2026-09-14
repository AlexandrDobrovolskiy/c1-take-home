# Load testing & autoscaling

> **Update (post-audit):** these numbers predate the single-store migration and should be read as *shape*, not absolutes: the read-scenario tables use closed-model pacing (queueing hides in throughput, not latency), the generator shares the host with the stack, and percentiles are loopback-measured. The write-path reconciliation proved MySQL+Mongo agreement; with one store that check is obsolete. See [post-audit.md](post-audit.md).

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

## Write-path throughput (no 429s — every request fully processed)

The runs above measure reads and limiter behavior; the paced `sends` scenario produced only ~1,200
real messages, and the abuse traffic was rejected *before* the write path. To measure actual
message processing, `tests/load/k6-throughput.js` drives sends with an **open-model arrival-rate
executor** (offered load holds even if latency degrades, so a ceiling shows up as rising
percentiles / dropped iterations instead of the tool slowing down), against the isolated stack
started with send limits raised via env (`SEND_RATE_CAPACITY=1000000 …`). Crucially the limiter
still executes its Redis Lua check on every request — only the rejections disappear — so the
measured pipeline is the full production path: limiter → membership check → MySQL insert →
Mongo body insert → Redis publish → WS fan-out to subscribers (60 sockets held throughout).

| offered peak | sends processed | send med | p95 | p99 | failures |
|---|---|---|---|---|---|
| 600/s  | 49,250  | 1.6 ms | 3.0 ms | 4.7 ms | 0 |
| 2,000/s | 161,250 | 2.0 ms | 3.7 ms | 5.7 ms | 0 |

No dropped iterations at either rate — 3 replicas sustained **2,000 fully-processed messages/sec**
(≈6,400 WS deliveries/sec at the observed ~3.2 subscribers/conversation) and the ceiling was not
reached on this hardware.

**End-to-end integrity reconciliation** — the proof that "processed" means processed. After each
run, three independent counts must agree: k6's 201 count, the MySQL `messages` row delta, and the
Mongo `message_bodies` delta (plus zero empty/missing bodies):

```
600/s run:    49,250 == 49,250 == 49,250   (empty bodies: 0)   RECONCILED
2,000/s run: 161,250 == 161,250 == 161,250                     RECONCILED
```

Every message accepted with 201 landed in both stores under both loads — the dual-write with
idempotent retry healing held up with no drift. No restarts or OOM kills in either run.

## Round 2: max-scale run, spike tuning, and a config lesson

Follow-up asks: heavier load (beyond 3 replicas), and shrinking the p99 spike that appears in the
window between load arriving and new replicas taking traffic.

**Tuning applied:**
- Autoscaler became HPA-like: 5s ticks, trigger at 60%, and **proportional jumps**
  (`desired = ceil(replicas × cpu / 55%)`) — under a steep ramp it goes 2→3→5→6 in ~60s instead of
  +1 per cooldown. Scale-down stays slow (12 quiet ticks).
- Envoy: `LEAST_REQUEST` balancing (stops blind round-robin into a saturated or cold replica),
  `dns_refresh_rate: 2s` (new replicas take traffic sooner), and a conservative retry policy
  (`connect-failure,refused-stream` only — never reached a handler, so safe for non-idempotent
  routes) to absorb connection churn during scale events.

**Spike result (identical 3,000/s runs):** server-side p99 spike 54ms → 44ms, failures during
transitions 0.06%→0.26%→0.12% across runs (noise-level). Honest conclusion: reactive scaling always
has a detection+boot window (~10-15s here); tuning shrinks the spike but only headroom (higher MIN)
or predictive scaling eliminates it. The spike is confined to p99 — p95 stayed single-digit ms
throughout.

**Max-scale run (offered 6,000 sends/s, start at 2 replicas, MAX=6):** autoscaler stepped 2→3→5→6;
**479,686 messages fully processed (99.87%)**, 0.12% failures, ~5/s dropped iterations at peak;
send med 6.4ms / p95 21ms / p99 44ms — elevated but stable at double the previously verified
comfortable rate, with zero 5xx. On 18 host cores shared with the DBs and the load generator
itself, ~6,000 processed sends/s (≈19,000 WS deliveries/s) is the practical ceiling of this setup.

**Config lesson (found via the dashboard):** the first heavy run showed a 429 storm on the
rate-limit panel. Cause: the autoscaler shells out to `docker compose up`, and without
`SEND_RATE_*` in *its* environment, compose interpolated production limits into newly created
replicas — which then rejected the load test. Uniform config across replicas matters, and env-var
interpolation at scale time is a footgun; noted in docker-compose.loadtest.yml. The observability
stack caught it in one glance — which is rather the point of having it.
