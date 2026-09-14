# Search (tasks/search.md)

> **Update (post-audit):** search now runs on MySQL FULLTEXT (single store — Mongo was removed, see [post-audit.md](post-audit.md)); the contract, scoping, fallback, and UI below are unchanged.

## Approach — Telegram-style unified search

One query, two indexes searched in the same request, results grouped by kind (the way Telegram's
global search returns chats first, then messages with chat + snippet):

- **Chats**: title match over the user's own conversations. That set is small and already loaded
  for scoping (below), so it's an in-process filter — no extra query, no `LIKE '%…%'` scan.
- **Messages**: MongoDB **text index** on `message_bodies.body` — indexed word/stem matching ranked
  by relevance score, newest-first among equals, capped at 20. Word indexes can't match partial
  words ("phoen", "track" mid-typing), so when `$text` finds nothing we fall back to a
  case-insensitive substring match — **bounded** to the user's conversations (via the
  `conversationId` index) and the same cap, so the fallback can't run away.

`GET /api/search?q=…` → `{ conversations: [...], messages: [...] }`; each message hit carries
`conversationTitle`, `senderUsername`, and `messageId`.

## Authorization is inside the query

The first step loads the user's conversation ids from MySQL; both Mongo queries are constrained by
`conversationId ∈ that set`. A matching title or body in a conversation the user doesn't belong to
can never surface — covered by a dedicated negative test (an "outsider" conversation whose title
and messages match the query must stay invisible).

## UX

- **Search-as-you-type** (300 ms debounce, min 2 chars, stale responses discarded by sequence
  number), grouped "Chats" / "Messages" sections.
- Clicking a message result **jumps to that message**: reuses the cursor pagination
  (`before = messageId + 1` gives the page *ending* at the hit), highlights it, and offers
  "↓ Jump to latest". Older context loads with the existing "Load older" button.
- The endpoint has its own per-user token bucket (15 burst / 5 per sec) so as-you-type can't hammer
  the backend.

## Performance notes

- Measured ~4–5 ms per search on the running stack.
- Text index + scoped fallback means cost tracks the user's data, not the whole corpus.
- Honest limits, and the upgrade path: Mongo `$text` is word/stem-based (no infix ranking, single
  language stemmer) and the substring fallback, while bounded, is a scan over the user's messages.
  At real scale the next step is a search engine (Meilisearch/Elastic, or Atlas Search with
  edge-grams) fed from the write path — the service seam (`searchAll`) is where it would plug in.

## Fixed alongside

The `seed` service ran `deleteMany({})` on **every** `docker compose up`, wiping all message bodies
while their MySQL rows survived (discovered when a Docker restart orphaned the whole history).
Seed now only populates an empty store.
