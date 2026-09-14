# Observability: Grafana dashboard for load & scaling

> **Update (post-audit):** /metrics now lives on a dedicated internal-only port (9091) that Envoy never routes — the edge path-block described below was bypassable (`/Metrics`) and is gone. Grafana anonymous access is Viewer-only now.

`docker compose up` now includes **Prometheus + Grafana**, fully provisioned — open
<http://localhost:3001/d/relay> (anonymous access in dev; put real auth in front for production)
and the "Relay — Load & Scaling" dashboard is already there with data flowing. The isolated
load-test stack gets the same pair automatically (Grafana on 3101).

## How it fits the architecture

- **App metrics** (`src/metrics.ts`, prom-client): request rate + latency histograms labeled by
  route (safe cardinality — ids travel in query strings), WebSocket connections, messages
  processed, WS fan-out deliveries, 429s by limiter, plus per-process CPU/memory/event-loop lag.
  The route label is captured *before* router dispatch (Express rewrites `req.url` during routing,
  so labeling at `finish` time misattributes requests).
- **Replica discovery = DNS, again.** Prometheus finds api replicas with `dns_sd_configs` on the
  service name — the same mechanism Envoy load-balances with — so replicas added or removed by the
  autoscaler appear on the dashboard automatically within one scrape interval. `count(up)` *is*
  the scaling graph.
- **`/metrics` stays internal**: scraped over the compose network; Envoy answers 404 for it at the
  public edge (verified).
- **k6 lands on the same dashboard**: Prometheus runs with `--web.enable-remote-write-receiver`,
  so load tests can stream their metrics next to server internals:
  ```
  docker run --rm --network relay-load_default -v "$PWD/tests/load:/scripts:ro" \
    -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
    grafana/k6 run -o experimental-prometheus-rw /scripts/k6-throughput.js
  ```
  The two "k6" panels (VUs, offered req/s) fill in during a run and read "no k6 run" otherwise.

## Panels

Top stats: replicas online, total req/s, 5xx/s, WS connections. Then: req/s by route; latency
p50/p95/p99; **CPU per replica with the 0.7-core autoscaler threshold marked**; memory per replica;
replica count over time (scaling events as steps); event-loop lag p99 per replica (the metric that
would have exposed the old pbkdf2Sync bug instantly); messages sent vs WS deliveries; rate-limit
rejections by limiter; k6 VUs and offered rate.

Verified live: with traffic flowing and a manual scale 3→5, the dashboard showed the replica step,
five CPU/memory series appearing, route-level RPS, and the send-limiter rejections from a
deliberately over-sending client. Everything is provisioned from files
(`docker/grafana/provisioning/`, `docker/prometheus/prometheus.yml`) — no manual Grafana setup.
