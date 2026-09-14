// Bulk data for the isolated load-test stack (run inside the api container):
//   docker compose -p relay-load ... exec api npx tsx tests/load/seed.mts
//
// Creates LOAD_USERS users (loaduser1..N, password "load"), LOAD_CONVS
// conversations with members assigned round-robin, and LOAD_MSGS messages per
// conversation (bodies word-seeded so search has realistic hits).

import { pool, waitForMysql } from '../../src/db/mysql.ts';
import { closeMongo, connectMongo, ensureMongoIndexes, mongo } from '../../src/db/mongo.ts';
import { hashPassword } from '../../src/auth/passwords.ts';

const USERS = Number(process.env.LOAD_USERS || 50);
const CONVS = Number(process.env.LOAD_CONVS || 20);
const MSGS = Number(process.env.LOAD_MSGS || 500);
const WORDS = ['order', 'delivery', 'update', 'tracking', 'invoice', 'schedule', 'design', 'launch', 'metrics', 'summary'];

await waitForMysql();
await connectMongo();
await ensureMongoIndexes();

const [[{ n }]] = (await pool.query(
  "SELECT COUNT(*) AS n FROM users WHERE username LIKE 'loaduser%'",
)) as unknown as [{ n: number }[]];
if (n > 0) {
  console.log('load data already present — skipping');
  process.exit(0);
}

console.log(`seeding ${USERS} users, ${CONVS} conversations, ${CONVS * MSGS} messages…`);
const hash = await hashPassword('load'); // same password for every load user

const [u] = await pool.query('INSERT INTO users (name, email, username, password_hash) VALUES ?', [
  Array.from({ length: USERS }, (_, i) => [
    `Load User ${i + 1}`, `load${i + 1}@test.local`, `loaduser${i + 1}`, hash,
  ]),
]);
const firstUserId = (u as { insertId: number }).insertId;

const [c] = await pool.query('INSERT INTO conversations (title) VALUES ?', [
  Array.from({ length: CONVS }, (_, i) => [`load conv ${i + 1}`]),
]);
const firstConvId = (c as { insertId: number }).insertId;

// loaduser i (0-based) belongs to conv (i % CONVS)
await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ?', [
  Array.from({ length: USERS }, (_, i) => [firstConvId + (i % CONVS), firstUserId + i]),
]);

const bodies = mongo().collection('message_bodies');
for (let cv = 0; cv < CONVS; cv++) {
  const convId = firstConvId + cv;
  const members = Array.from({ length: USERS }, (_, i) => i).filter((i) => i % CONVS === cv);
  const [m] = await pool.query('INSERT INTO messages (conversation_id, sender_id) VALUES ?', [
    Array.from({ length: MSGS }, (_, k) => [convId, firstUserId + members[k % members.length]]),
  ]);
  const firstMsgId = (m as { insertId: number }).insertId;
  await bodies.insertMany(
    Array.from({ length: MSGS }, (_, k) => ({
      _id: (firstMsgId + k) as never,
      conversationId: convId,
      senderId: firstUserId + members[k % members.length],
      body: `${WORDS[k % WORDS.length]} ${WORDS[(k + 3) % WORDS.length]} message ${k} in load conv ${cv + 1}`,
      createdAt: new Date(),
    })),
    { ordered: false },
  );
}

console.log('load seed done');
await pool.end();
await closeMongo();
process.exit(0);
