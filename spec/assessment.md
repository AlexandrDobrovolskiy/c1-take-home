# Initial assessment & plan

The first working session: read the whole codebase (~400 lines), verified suspicions against the
running app, and ranked everything before changing any code. Kept here as the plan the work
followed; outcomes are in `docs/`.

## Confirmed bugs (reproduced before fixing)

1. **Event-loop blocking on every send** — `pbkdf2Sync(body, 'relay-signing', 200000)` in
   `createMessage`: measured ~19ms of synchronous CPU per message; 10 concurrent sends serialized
   to 0.40s. Not actually a signature (static salt, no key, no reader).
2. **Duplicate messages on retry** — UI sends a `clientId` and the column exists, but nothing
   enforces it. Reproduced: same `clientId` twice → two rows.
3. **Async route handlers can kill the process** — Express 4 + unhandled rejections; any DB hiccup
   crashes (masked by `restart: on-failure`).
4. **Non-atomic dual write** — MySQL row then Mongo body; a Mongo failure leaves a permanently
   body-less message.
5. **Stored XSS** — conversation titles rendered via `innerHTML`.

## Performance / scalability

6. **N+1** on inbox listing (1 + 2 per conversation) and **no index** on
   `messages(conversation_id)` — every lookup a full table scan.
7. **Unbounded history fetch** — whole conversation + Mongo `$in` over every id on each open.
8. **WS hub is single-instance** — in-process `Set`; broadcast can't cross replicas (this is the
   multi-instance task; Redis is provisioned but unused).
9. **No WS reconnect/heartbeat** — dead sockets leak server-side; dropped clients go silent.

## Security

10. **No authentication or authorization at all** — `userId`/`senderId` are client-supplied; any
    user can read/post/subscribe anywhere. Biggest gap; fix first.
11. Input hardening gaps — no length caps, no FK constraints, `Number(uid)` NaN → 500s, no rate
    limiting (also an explicit task).

## Order of work (as executed)

Auth + authorization → event-loop & idempotency fixes (TDD) → N+1 + index (TDD) → pagination + WS
resilience → multi-instance fan-out → rate limiting (TDD) → search (TDD) → typing indicator →
load testing + autoscaler → observability. Fix notes land in `docs/02-fixes.md`; each feature gets
its own doc; every fix arrives with tests that failed first (RED) and pass after (GREEN).
