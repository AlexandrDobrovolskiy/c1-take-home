import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pool, waitForMysql } from '../src/db/mysql.ts';
import { createMessage, listMessages } from '../src/services/messages.ts';

// Integration tests — run against the compose MySQL (docker compose exec api npm test).
// All rows are scoped to a throwaway conversation created here and removed in after().

let convId: number;

before(async () => {
  await waitForMysql();
  const [created] = await pool.execute(
    "INSERT INTO conversations (title) VALUES ('test: createMessage')",
  );
  convId = (created as { insertId: number }).insertId;
  await pool.execute(
    'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, 1)',
    [convId],
  );
});

after(async () => {
  await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  await pool.execute('DELETE FROM conversation_participants WHERE conversation_id = ?', [convId]);
  await pool.execute('DELETE FROM conversations WHERE id = ?', [convId]);
  await pool.end();
});

describe('createMessage clientId idempotency', () => {
  it('a retried clientId returns the original message instead of duplicating', async () => {
    const input = { conversationId: convId, senderId: 1, body: 'retried send', clientId: 'test-dup-1' };
    const first = await createMessage(input);
    const second = await createMessage({ ...input, body: 'retried send (changed)' });

    assert.equal(second.id, first.id, 'retry must return the already-created message');
    assert.equal(second.body, first.body, 'the original body wins');
    assert.equal(second.deduped, true, 'retry is flagged so callers skip re-broadcast');
    assert.ok(!first.deduped, 'original send is not flagged');

    const [[row]] = (await pool.query(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND client_id = ?',
      [convId, 'test-dup-1'],
    )) as unknown as [{ n: number }[]];
    assert.equal(row.n, 1, 'exactly one row per clientId');

    const page = await listMessages(convId);
    assert.equal(page.messages.filter((m) => m.body === 'retried send').length, 1);
  });

  it('two concurrent sends with the same clientId converge on one message', async () => {
    const input = { conversationId: convId, senderId: 1, body: 'race', clientId: 'test-dup-race' };
    const [a, b] = await Promise.all([createMessage(input), createMessage(input)]);
    assert.equal(a.id, b.id, 'concurrent duplicates must converge on one id');
    assert.ok(a.deduped !== b.deduped, 'exactly one of the two is the original');
  });

  it('distinct clientIds and null clientIds still create distinct messages', async () => {
    const a = await createMessage({ conversationId: convId, senderId: 1, body: 'a', clientId: 'test-dup-2' });
    const b = await createMessage({ conversationId: convId, senderId: 1, body: 'b', clientId: 'test-dup-3' });
    assert.notEqual(a.id, b.id);

    const c = await createMessage({ conversationId: convId, senderId: 1, body: 'c', clientId: null });
    const d = await createMessage({ conversationId: convId, senderId: 1, body: 'd', clientId: null });
    assert.notEqual(c.id, d.id, 'null clientId must never dedupe');
  });
});

describe('createMessage event-loop behavior', () => {
  it('does not block the event loop under concurrent sends', async () => {
    const SENDS = 20;
    // A 5ms ticker accumulates drift: any synchronous CPU on the loop shows up
    // as missed ticks. The old pbkdf2Sync cost ~20ms/message => ~400ms drift.
    let blockedMs = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      blockedMs += Math.max(0, now - last - 5);
      last = now;
    }, 5);

    try {
      await Promise.all(
        Array.from({ length: SENDS }, (_, i) =>
          createMessage({
            conversationId: convId,
            senderId: 1,
            body: `block probe ${i}`,
            clientId: `test-block-${i}`,
          }),
        ),
      );
    } finally {
      clearInterval(tick);
    }

    assert.ok(
      blockedMs < 100,
      `event loop blocked ~${Math.round(blockedMs)}ms during ${SENDS} concurrent sends (limit 100ms)`,
    );
  });
});
