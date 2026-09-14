import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool, waitForMysql } from '../src/db/mysql.ts';
import { closeMongo, connectMongo, ensureMongoIndexes, mongo } from '../src/db/mongo.ts';
import { createMessage } from '../src/services/messages.ts';
import { searchAll } from '../src/services/search.ts';

// Integration tests (docker compose exec api npm test).
// searcher is in "Phoenix launch plan" and "Groceries"; outsider owns
// "Phoenix secret" — nothing from it may ever surface for searcher.

let searcher: number;
let outsider: number;
const convIds: number[] = [];

async function insert(sql: string, params: unknown[] = []): Promise<number> {
  const [res] = await pool.execute(sql, params);
  return (res as { insertId: number }).insertId;
}

async function makeConv(title: string, userId: number): Promise<number> {
  const id = await insert('INSERT INTO conversations (title) VALUES (?)', [title]);
  await insert('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [id, userId]);
  convIds.push(id);
  return id;
}

before(async () => {
  await waitForMysql();
  await connectMongo();
  await ensureMongoIndexes();
  searcher = await insert(
    "INSERT INTO users (name, email, username, password_hash) VALUES ('Search Test', 's@test.local', 'test-search-user', 'x')",
  );
  outsider = await insert(
    "INSERT INTO users (name, email, username, password_hash) VALUES ('Search Outsider', 'o@test.local', 'test-search-outsider', 'x')",
  );
  const phoenix = await makeConv('test: Phoenix launch plan', searcher);
  const secret = await makeConv('test: Phoenix secret', outsider);
  const groceries = await makeConv('test: Groceries', searcher);

  let i = 0;
  const send = (conversationId: number, senderId: number, body: string) =>
    createMessage({ conversationId, senderId, body, clientId: `test-search-${i++}` });
  await send(phoenix, searcher, 'the phoenix rises tomorrow at dawn');
  await send(phoenix, searcher, 'completely unrelated standup notes');
  await send(groceries, searcher, 'buy milk and phoenix feathers');
  await send(secret, outsider, 'phoenix confidential financials');
});

after(async () => {
  await mongo().collection('message_bodies').deleteMany({ conversationId: { $in: convIds } });
  await pool.query('DELETE FROM messages WHERE conversation_id IN (?)', [convIds]);
  await pool.query('DELETE FROM conversation_participants WHERE conversation_id IN (?)', [convIds]);
  await pool.query('DELETE FROM conversations WHERE id IN (?)', [convIds]);
  await pool.query('DELETE FROM users WHERE id IN (?)', [[searcher, outsider]]);
  await pool.end();
  await closeMongo();
});

describe('searchAll', () => {
  it('finds conversations and messages in one call', async () => {
    const r = await searchAll(searcher, 'phoenix');
    assert.deepEqual(r.conversations.map((c) => c.title), ['test: Phoenix launch plan']);
    const bodies = r.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['buy milk and phoenix feathers', 'the phoenix rises tomorrow at dawn']);
  });

  it('never leaks conversations or messages the user is not a participant of', async () => {
    const r = await searchAll(searcher, 'phoenix');
    assert.ok(!r.conversations.some((c) => c.title.includes('secret')), 'outsider conversation title leaked');
    assert.ok(!r.messages.some((m) => m.body.includes('confidential')), 'outsider message leaked');
    const confidential = await searchAll(searcher, 'confidential');
    assert.equal(confidential.messages.length, 0);
    const outsiderView = await searchAll(outsider, 'phoenix');
    assert.deepEqual(outsiderView.messages.map((m) => m.body), ['phoenix confidential financials']);
  });

  it('message results carry conversation title and sender username', async () => {
    const r = await searchAll(searcher, 'dawn');
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].conversationTitle, 'test: Phoenix launch plan');
    assert.equal(r.messages[0].senderUsername, 'test-search-user');
    assert.ok(r.messages[0].messageId > 0);
  });

  it('falls back to substring match when the word index has no hit', async () => {
    const r = await searchAll(searcher, 'phoen'); // partial word — $text cannot match it
    assert.ok(r.messages.length >= 2, 'prefix should match via fallback');
    assert.ok(r.messages.every((m) => m.body.includes('phoen')));
  });

  it('caps results', async () => {
    const r = await searchAll(searcher, 'phoenix', 1);
    assert.equal(r.messages.length, 1);
    assert.equal(r.conversations.length, 1);
  });
});
