# Fix notes

> **Update (post-audit):** fixes 2 and 4 below describe the MySQL+Mongo era; the dual write was later collapsed into a single MySQL store, which retires the ghost-message failure mode and the healing path entirely. Client-side retry now reuses the clientId, making the idempotency fix effective for human retries. See [post-audit.md](10-post-audit.md).

Short note per fix, as requested — what was actually wrong and what changed.
Both fixes below were done test-first (RED/GREEN): `tests/messages.test.ts`, run with
`docker compose exec api npm test` (Node's built-in test runner via `tsx --test`, no new deps).

## 1. Every message send blocked the event loop (~20 ms of CPU)

**What was wrong.** `createMessage` computed `crypto.pbkdf2Sync(body, 'relay-signing', 200000, …)`
on every send. PBKDF2 with 200k iterations is a *deliberately slow* password-stretching KDF —
measured ~19 ms of synchronous CPU per message. Because it's sync, it froze the whole event loop:
under 20 concurrent sends the loop was blocked ~392 ms (measured by the RED test), which serializes
every request, stalls WebSocket delivery, and caps a single instance at roughly 30–50 messages/sec
regardless of I/O capacity. It also wasn't a signature in any meaningful sense: static string salt,
no secret key, and nothing anywhere read the stored value.

**Fix.** Removed it (and the stored `signature` field, which had no reader). If message integrity
is ever actually needed, the right tool is a keyed `HMAC-SHA256` — microseconds, not milliseconds.

**Result.** Send latency 40 ms → ~7 ms; 10 concurrent sends 0.40 s → 0.12 s; event-loop drift
during 20 concurrent sends ~392 ms → within noise (< 100 ms asserted, actual ≈ few ms).

## 2. Client retries created duplicate messages

**What was wrong.** The UI already sent a `clientId` UUID per message and the schema already had a
`messages.client_id` column — clearly intended as an idempotency key — but nothing enforced it.
Any retry (double-click, flaky network, runaway script re-POSTing) inserted a brand-new row.
Reproduced trivially: two POSTs with the same `clientId` → two messages.

**Fix.** Enforced at the only layer that survives concurrency and multiple instances — the database:
`UNIQUE KEY (conversation_id, client_id)` (NULL `client_id` stays exempt; MySQL permits repeated
NULLs in a unique index). `createMessage` treats `ER_DUP_ENTRY` as "this is a retry" and returns the
original message instead. No pre-check `SELECT` — the insert is the check, so two *concurrent*
identical sends also converge on one id (covered by a race test).

Bonus resilience: on the retry path the Mongo body is written with an upsert +`$setOnInsert`, so a
send that previously died between its MySQL and Mongo writes gets its body healed by the retry
instead of staying permanently empty (partial mitigation of the non-atomic dual-write issue, which
is tracked separately).

**Result.** Same `clientId` twice over HTTP → same message id both times, one row in MySQL, one
body in Mongo; distinct/null `clientId`s unaffected.

## 3. N+1 queries on the inbox + no index on messages

**What was wrong.** `GET /api/conversations` ran 1 query for the list plus 2 queries *per
conversation* (last message, count) — 1+2N round trips (RED test measured 7 queries for 3
conversations; 50 conversations would be 101). On top of that, `messages` had no index on
`conversation_id`, so every one of those lookups — and every history read — was a full table scan
over *all* messages in the system.

**Fix.** Test-first (`tests/conversations.test.ts`): correctness tests pin the response shape
(last message, counts, empty conversations), and a query-count guard asserts a listing takes ≤ 2
queries regardless of conversation count. The listing was extracted to
`src/services/conversations.ts` and rewritten as a single query — `LEFT JOIN LATERAL` computes
`COUNT(*)` + `MAX(id)` per conversation, then one join picks up the last message row. Added
`KEY idx_messages_conversation (conversation_id)` (InnoDB appends the PK, so it acts as
`(conversation_id, id)`, id-ordered per conversation).

**Result.** 1+2N queries → 1 query; `EXPLAIN FORMAT=TREE` shows the aggregate as a *covering index
lookup* on `idx_messages_conversation` — cost now tracks the user's conversation count, not total
messages in the table. The same index also serves `GET /api/messages` history reads.

## 4. Unbounded history fetch → cursor pagination

**What was wrong.** `GET /api/messages` returned the *entire* conversation history on every open —
an unbounded MySQL read plus a Mongo `$in` over every message id. Memory and latency grew linearly
with conversation size, on every single open.

**Fix.** Test-first (`tests/pagination.test.ts`). Cursor pagination in `listMessages`:
`GET /api/messages?conversationId=X[&limit=50][&before=<id>]` returns
`{ messages (ascending), nextCursor }` — pass `nextCursor` as `before` for the next-older page.
Message id is the cursor (monotonic per the PK, stable under concurrent writes — offset pagination
would skip/duplicate rows as new messages land). The query is a newest-first index scan on
`(conversation_id, id)` with `LIMIT n+1` to detect whether more history exists without a COUNT;
the Mongo `$in` is now bounded by the page size (max 100). UI shows a "Load older messages" button
that prepends a page while keeping the scroll position anchored.

**Note.** This changed the endpoint's response shape from a bare array to an envelope — the UI is
the only consumer, updated in the same commit.

## 5. WebSocket resilience: server heartbeat + client auto-reconnect

**What was wrong.** Two halves of the same problem. Server: dead peers (network drop, killed tab)
never send a close frame, so their sockets stayed in the hub's `clients` set forever — a slow leak,
and `broadcast` kept writing into the void. Client: any dropped connection silently ended live
updates; worse, the UI relies on the WS echo to display your own sent messages, so sends appeared
to vanish.

**Fix.** Server: standard ping/pong heartbeat every 30s — sockets that miss a pong are terminated,
which fires their `close` handler and drops them from the set. Client: `onclose` triggers
exponential backoff (1s → 15s cap); each attempt re-fetches the conversation list and the open
conversation (catching up on anything missed while offline), then reconnects and re-subscribes.
A 4401 close (token expired/invalid) reloads to the login screen instead of retry-looping, and a
401 from any refresh does the same.

**Verified live:** browser tab open → `docker compose restart api` → client reconnected on backoff
and a message posted by another user immediately appeared over the new socket.
