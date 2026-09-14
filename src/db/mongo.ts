import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.ts';

const client = new MongoClient(config.mongoUrl);
let db: Db | undefined;

export async function connectMongo(retries = 20): Promise<Db> {
  for (let i = 0; i < retries; i++) {
    try {
      await client.connect();
      db = client.db();
      return db;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('mongo not reachable');
}

export function mongo(): Db {
  if (!db) throw new Error('mongo not connected');
  return db;
}

export async function closeMongo(): Promise<void> {
  await client.close();
}

// Idempotent; safe when several instances race it at startup.
export async function ensureMongoIndexes(): Promise<void> {
  const bodies = mongo().collection('message_bodies');
  await bodies.createIndex({ body: 'text' }); // word/stem search with relevance scores
  await bodies.createIndex({ conversationId: 1 }); // scoped scans (search fallback, cleanups)
}
