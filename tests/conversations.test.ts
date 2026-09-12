import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool, waitForMysql } from '../src/db/mysql.ts';
import { listConversations } from '../src/services/conversations.ts';

// Integration tests — run against the compose MySQL (docker compose exec api npm test).
// A throwaway user owns three conversations with 3 / 0 / 1 messages.

let userId: number;
const convIds: number[] = [];
let lastMsgIdA: number;

async function insert(sql: string, params: unknown[]): Promise<number> {
  const [res] = await pool.execute(sql, params);
  return (res as { insertId: number }).insertId;
}

before(async () => {
  await waitForMysql();
  userId = await insert(
    "INSERT INTO users (name, email, username, password_hash) VALUES ('N1 Test', 'n1@test.local', 'test-n1-user', 'x')",
    [],
  );
  for (const title of ['test n1: A', 'test n1: B', 'test n1: C']) {
    const id = await insert('INSERT INTO conversations (title) VALUES (?)', [title]);
    await insert('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [id, userId]);
    convIds.push(id);
  }
  // conv A: 3 messages, conv B: none, conv C: 1
  for (let i = 0; i < 3; i++) {
    lastMsgIdA = await insert('INSERT INTO messages (conversation_id, sender_id) VALUES (?, ?)', [convIds[0], userId]);
  }
  await insert('INSERT INTO messages (conversation_id, sender_id) VALUES (?, ?)', [convIds[2], userId]);
});

after(async () => {
  await pool.query('DELETE FROM messages WHERE conversation_id IN (?)', [convIds]);
  await pool.query('DELETE FROM conversation_participants WHERE conversation_id IN (?)', [convIds]);
  await pool.query('DELETE FROM conversations WHERE id IN (?)', [convIds]);
  await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
  await pool.end();
});

describe('listConversations', () => {
  it('returns each conversation with correct lastMessage and messageCount', async () => {
    const list = await listConversations(userId);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((c) => c.id), [...convIds].sort((a, b) => a - b));

    const [a, b, c] = list;
    assert.equal(a.messageCount, 3);
    assert.equal(a.lastMessage?.id, lastMsgIdA, 'lastMessage must be the newest message');
    assert.equal(a.lastMessage?.senderId, userId);
    assert.ok(a.lastMessage?.createdAt instanceof Date);

    assert.equal(b.messageCount, 0, 'empty conversation has zero count');
    assert.equal(b.lastMessage, null, 'empty conversation has no lastMessage');

    assert.equal(c.messageCount, 1);
  });

  it('returns nothing for a user with no conversations', async () => {
    assert.deepEqual(await listConversations(999999), []);
  });

  it('issues a constant number of queries regardless of conversation count (no N+1)', async () => {
    const origQuery = pool.query.bind(pool);
    const origExecute = pool.execute.bind(pool);
    let queries = 0;
    (pool as { query: unknown }).query = (...args: unknown[]) => {
      queries++;
      return (origQuery as (...a: unknown[]) => unknown)(...args);
    };
    (pool as { execute: unknown }).execute = (...args: unknown[]) => {
      queries++;
      return (origExecute as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await listConversations(userId);
    } finally {
      (pool as { query: unknown }).query = origQuery;
      (pool as { execute: unknown }).execute = origExecute;
    }
    assert.ok(
      queries <= 2,
      `listing 3 conversations took ${queries} queries — per-conversation queries scale as N+1`,
    );
  });
});
