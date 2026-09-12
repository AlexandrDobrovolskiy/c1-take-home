# Fix notes

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
