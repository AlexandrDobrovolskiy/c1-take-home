import { connectMongo, mongo } from '../../src/db/mongo.ts';

await connectMongo();
const bodies = mongo().collection('message_bodies');

// The seed service runs on every `docker compose up`. Only seed an empty
// store — wiping message_bodies on restart would orphan every MySQL message
// row (bodies live in Mongo, rows in MySQL).
if ((await bodies.countDocuments()) > 0) {
  console.log('message bodies already present — skipping seed');
  process.exit(0);
}

await bodies.insertMany([
  { _id: 1 as never, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?', createdAt: new Date() },
  { _id: 2 as never, conversationId: 1, senderId: 1, body: 'Checking now — give me a minute.', createdAt: new Date() },
  { _id: 3 as never, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.', createdAt: new Date() },
]);
console.log('seeded message bodies');
process.exit(0);
