# Post-audit remediation

What changed after the five-role audit (`audit.md`), in commit order. Older docs describe the
system as it was when they were written; where a claim was corrected, the doc carries an
"Update (post-audit)" note pointing here.

## Architecture (P2)

- **Single store** — messages carry `body TEXT` in MySQL (bodies cap at 4,000 chars; the Mongo
  split bought nothing). Sends are one atomic insert; the dual-write failure class, the dead-code
  "healing" path, and the per-read `$in` join are gone. Search runs on MySQL FULLTEXT with the same
  scoped LIKE fallback. MongoDB is removed from the stack entirely.
- **Delivery indexes + backpressure** — the hub delivers via conversation- and user-keyed socket
  indexes (O(recipients) per event); sockets buffering >4MB are terminated (their reconnect path
  recovers). Subscribe frames are capped (200 ids), serialized per socket, and **ACKed** — the
  client fetches history only after `subscribed`, closing the connect→resubscribe loss window.
- **Membership events** — creating a conversation publishes a user-targeted event
  (`broadcastToUsers`); invitees' live sockets learn about it without a reload.
- **Redis separation** — three clients (pub / sub / limiter): limiter EVALs and fan-out PUBLISHes
  no longer share a socket. The token-bucket Lua takes time from Redis `TIME` — one clock for all
  replicas; cross-instance skew can't rewind buckets.

## Security (P0 — all found-exploitable items closed)

- Boot **fails on the default `AUTH_SECRET` in production** and warns loudly in dev;
  `.dockerignore` keeps `.env`/`.git` out of images.
- **XFF chain fixed**: Envoy `use_remote_address: true` (client-supplied XFF ignored, real peer
  appended) + Express `trust proxy: 1`. Verified: rotating spoofed XFF now shares one bucket
  (429 by attempt ~10; previously unlimited). Login limiting is **two buckets** (per IP and per
  target username) and **fails closed** (503) when Redis is down.
- **Pre-auth crash fixed**: malformed cookie percent-encoding no longer kills the replica via the
  WS upgrade path (guarded decode; regression-tested over HTTP and WS).
- **Metrics moved to an internal-only port (9091)** that Envoy never routes — the `/Metrics`
  case-bypass class is gone by construction.
- New `tests/auth.test.ts`: nine enforcement tests (no/garbage/malformed token, tampered MAC,
  altered payload, expired, wrong secret, membership 403s) — the auth layer is no longer the
  least-tested code in the repo.

## Product correctness (P1)

- **Retries are real now**: a failed send keeps its clientId and retries with it, so the
  idempotency key protects against human retries, not just synthetic ones; deduped retries are not
  re-broadcast and don't inflate counters. The client also dedups rendered messages by id.
- **Stale-response discipline**: a view-generation counter guards `openConversation`, `loadOlder`,
  and search rendering — fast navigation can no longer splice the wrong conversation into the pane.
- **Unread state persists** (`conversation_participants.last_read_message_id`, monotonic marker,
  `POST /api/conversations/:id/read`) — survives reloads and follows the user across devices.

## Ops (P3)

- Named volumes for MySQL/Redis/Prometheus/Grafana — `docker compose down` no longer destroys data.
- Graceful drain on SIGTERM/SIGINT (stop accepting, close WS with 1001 so clients fail over,
  finish in-flight, 8s deadline) — and tsx runs as PID 1 because `npm start` swallowed SIGTERM
  (verified before/after).
- MySQL host port unpublished; Grafana anonymous role reduced to Viewer; restart policies on all
  services; the demo-seed service is gone (demo data ships in the MySQL init script).

## Still open (deliberate, documented)

- No event-gap detection beyond the resubscribe refetch: a Redis outage still means missed
  realtime for clients on other instances until something closes their socket (heartbeat within
  30s) — the honest fix is per-conversation sequence checks or Redis Streams.
- Stateless tokens still lack revocation before expiry (trade-off documented in auth.md).
- No signup, message edit/delete, delivery acks, forward (`after`) pagination from a search hit.
- Envoy still applies `timeout: 0s` to all routes (needed for WS; HTTP routes deserve a finite
  timeout), no outlier detection, no alerting rules — see audit.md P3 items 16–17.
- Benchmark claims in load-testing.md predate the single-store migration and should be read as
  shape, not gospel: closed-model pacing for the read tables, load generator co-located with the
  stack, loopback networking. The write-path reconciliation proved MySQL+Mongo agreement at the
  time; with one store, that class of check is no longer needed.
