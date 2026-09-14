# Multi-agent audit — findings & action plan

A five-role audit panel reviewed the codebase after feature-complete: a security auditor
(attack-minded, probed the running app), an architecture reviewer, a correctness reviewer, an
ops/SRE reviewer, and a devil's advocate charged with attacking the docs' claims. Findings were
deduplicated and ranked; several were verified by live probes, not speculation.

**Panel consensus on what held up:** the service layer — parameterized SQL, membership-scoped
queries, the atomic Lua limiter, the idempotency primitive, `textContent`-only rendering (no XSS,
no SQL/Mongo-operator/regex injection found).

**Where it broke:** configuration trust chains, realtime delivery under failure, frontend race
discipline, and a gap between documented claims ("verified") and what tests actually pin down.

## P0 — exploitable or crash-level (three verified by live probe)

1. **Default `AUTH_SECRET` ⇒ token forgery.** A token forged offline with the shipped default
   secret was accepted; full impersonation of any user. `.env` is also baked into the image
   (no `.dockerignore`). → Fail-fast boot on default/missing secret; add `.dockerignore`.
2. **X-Forwarded-For trust chain broken both ways** (probed): Envoy lacks `use_remote_address`
   and Express trusts all hops — attackers rotate XFF to bypass the login limiter entirely, while
   real browser traffic all shares one bucket (Envoy's IP): 10 failed logins lock out everyone.
   → `use_remote_address: true` + `trust proxy: 1` + per-username bucket + spoof test.
3. **Pre-auth DoS:** `Cookie: relay_token=%` throws `URIError` in `decodeURIComponent` inside the
   WS connection handler — uncaught, kills the replica. → try/catch.
4. **`/Metrics` bypasses the Envoy edge block** (Express routing is case-insensitive; probed).
   → serve metrics on an internal-only port instead of path-blocking at the edge.
5. **Login limiter fails open** when Redis is down — the brute-force control vanishes under infra
   stress. → fail closed for login.

## P1 — realtime correctness

6. **Silent message loss:** Redis outage severs cross-instance delivery while healthy sockets never
   trigger the client resync (the docs' claim that they do is false); plus a loss window between WS
   connect and the async subscribe completing. → subscribe ACK before history fetch; gap detection.
7. **The duplicate-send fix has no real consumer:** the client mints a fresh UUID per submit and
   never retries, so human retries still duplicate; a deduped retry also re-broadcasts to all
   clients and drifts counters; the concurrent-dup race can 500 the winning request.
   → stable clientId on retry, skip broadcast on dedupe, client dedup by id.
8. **Live membership changes don't propagate** — an invited user gets no realtime until reload.
9. **Frontend stale-response races:** `openConversation` / `loadOlder` / search responses clobber
   the current view under fast navigation. → view-generation guard after every await.
10. **Unread state is client-memory only** — wiped on every reload/resync. → persist per-user
    `last_read_message_id`.

## P2 — architecture decisions

11. **The MySQL+Mongo dual write is unjustified** (three agents independently): bodies cap at
    4,000 chars — a `TEXT` column + FULLTEXT deletes the whole consistency-failure class, makes
    sends transactional, and halves the read path. The "retry healing" is dead code from the real
    client. → collapse to one store.
12. **One Redis, two responsibilities, one shared connection:** limiter EVALs and fan-out PUBLISHes
    head-of-line block each other and fail together; `deliverLocal` linearly scans all sockets per
    event with no backpressure. → separate clients, conversation→sockets index, `bufferedAmount`
    cutoff.
13. **Limiter clock skew:** the Lua script trusts each replica's clock; skew mints free tokens.
    → Redis `TIME`. Also: WS `subscribe` accepts thousands of ids per frame (DoS on MySQL `IN`).

## P3 — ops

14. Anonymous volumes: `docker compose down` permanently destroys all data. → named volumes.
15. No graceful shutdown: scale-in drops in-flight requests and every WS. → SIGTERM drain.
16. Open infra doors: MySQL `root/root` and Mongo published to the host, Grafana anonymous Admin,
    Envoy admin on 0.0.0.0, `timeout: 0s` on all routes (not just WS).
17. Only `api` has a restart policy; api boot is gated on the demo-seed service; prod image runs
    root/tsx/devDeps with a bind mount; no alerting.

## P4 — docs & test honesty

18. Correct two claims: "clients catch up via resync" on Redis failure; "req.ip is the real
    client". Soften two: the headline benchmark numbers (closed-model, co-located generator,
    loopback) and "all TDD'd" (fixes for async-crash/XSS/WS-resilience have no tests).
19. The auth layer — the flagship fix — has zero automated tests. → HTTP 401/403 suite, token
    tampering tests, WS non-member subscribe test.
20. The load-test "integrity reconciliation" proves the write path only; the WS delivery half is
    unmeasured. → rescope the claim; commit the reconciliation script.

Remediation from here is tracked in `docs/10-post-audit.md` and the commit history.
