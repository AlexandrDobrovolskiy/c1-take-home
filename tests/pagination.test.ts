import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool, waitForMysql } from '../src/db/mysql.ts';
import { createMessage, listMessages } from '../src/services/messages.ts';

// Integration tests — run against the compose MySQL (docker compose exec api npm test).
// A throwaway conversation gets 12 messages (bodies "m1".."m12", ascending ids).

let convId: number;
let userId: number;
const msgIds: number[] = [];

before(async () => {
  await waitForMysql();
  const [u] = await pool.execute(
    "INSERT INTO users (name, email, username, password_hash) VALUES ('Page Test', 'page@test.local', 'test-page-user', 'x')",
  );
  userId = (u as { insertId: number }).insertId;
  const [c] = await pool.execute("INSERT INTO conversations (title) VALUES ('test: pagination')");
  convId = (c as { insertId: number }).insertId;
  await pool.execute(
    'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)',
    [convId, userId],
  );
  for (let i = 1; i <= 12; i++) {
    const m = await createMessage({
      conversationId: convId,
      senderId: userId,
      body: `m${i}`,
      clientId: `test-page-${i}`,
    });
    msgIds.push(m.id);
  }
});

after(async () => {
  await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  await pool.execute('DELETE FROM conversation_participants WHERE conversation_id = ?', [convId]);
  await pool.execute('DELETE FROM conversations WHERE id = ?', [convId]);
  await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
  await pool.end();
});

describe('listMessages cursor pagination', () => {
  it('returns the newest page in ascending order with bodies and a cursor', async () => {
    const page = await listMessages(convId, { limit: 5 });
    assert.deepEqual(page.messages.map((m) => m.body), ['m8', 'm9', 'm10', 'm11', 'm12']);
    assert.deepEqual(page.messages.map((m) => m.id), msgIds.slice(7));
    assert.equal(page.messages[0].senderUsername, 'test-page-user');
    assert.equal(page.nextCursor, msgIds[7], 'cursor points at the oldest message in the page');
  });

  it('walks backward with the cursor and ends with nextCursor null', async () => {
    const page1 = await listMessages(convId, { limit: 5 });
    const page2 = await listMessages(convId, { limit: 5, before: page1.nextCursor! });
    assert.deepEqual(page2.messages.map((m) => m.body), ['m3', 'm4', 'm5', 'm6', 'm7']);
    assert.equal(page2.nextCursor, msgIds[2]);

    const page3 = await listMessages(convId, { limit: 5, before: page2.nextCursor! });
    assert.deepEqual(page3.messages.map((m) => m.body), ['m1', 'm2']);
    assert.equal(page3.nextCursor, null, 'no cursor when history is exhausted');
  });

  it('an exactly-full last page still reports nextCursor null', async () => {
    const page = await listMessages(convId, { limit: 12 });
    assert.equal(page.messages.length, 12);
    assert.equal(page.nextCursor, null);
  });

  it('clamps unreasonable limits instead of failing', async () => {
    const huge = await listMessages(convId, { limit: 100000 });
    assert.equal(huge.messages.length, 12);
    assert.equal(huge.nextCursor, null);

    const zero = await listMessages(convId, { limit: 0 });
    assert.equal(zero.messages.length, 1, 'limit clamps up to at least 1');
    assert.equal(zero.messages[0].body, 'm12');
  });
});
