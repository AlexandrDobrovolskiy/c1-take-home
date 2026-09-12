import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';

export interface NewMessage {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
}

export interface Message {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
}

export async function createMessage(input: NewMessage): Promise<Message> {
  const { conversationId, senderId, body, clientId } = input;

  let id: number;
  try {
    const [res] = await pool.execute(
      'INSERT INTO messages (conversation_id, sender_id, client_id) VALUES (?, ?, ?)',
      [conversationId, senderId, clientId],
    );
    id = (res as { insertId: number }).insertId;
  } catch (err) {
    // Unique index on (conversation_id, client_id): a duplicate means this is a
    // retry (or a concurrent double-send) — return the original message.
    if (clientId && (err as { code?: string }).code === 'ER_DUP_ENTRY') {
      return existingMessage(conversationId, clientId, body);
    }
    throw err;
  }

  const createdAt = new Date();
  await mongo().collection('message_bodies').insertOne({
    _id: id as never,
    conversationId,
    senderId,
    body,
    createdAt,
  });

  return { id, conversationId, senderId, body, createdAt };
}

async function existingMessage(
  conversationId: number,
  clientId: string,
  retryBody: string,
): Promise<Message> {
  const [[row]] = (await pool.query(
    `SELECT id, sender_id AS senderId, created_at AS createdAt
     FROM messages WHERE conversation_id = ? AND client_id = ?`,
    [conversationId, clientId],
  )) as unknown as [{ id: number; senderId: number; createdAt: Date }[]];
  if (!row) throw new Error('duplicate clientId but original message not found');

  // The original request may have died between its MySQL and Mongo writes, so
  // heal a missing body on retry; $setOnInsert never overwrites an existing one.
  const doc = await mongo().collection('message_bodies').findOneAndUpdate(
    { _id: row.id as never },
    {
      $setOnInsert: {
        conversationId,
        senderId: row.senderId,
        body: retryBody,
        createdAt: row.createdAt,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return {
    id: row.id,
    conversationId,
    senderId: row.senderId,
    body: doc?.body ?? retryBody,
    createdAt: row.createdAt,
  };
}
