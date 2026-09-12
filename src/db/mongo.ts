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
