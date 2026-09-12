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

export interface MessagePage {
  messages: (Message & { senderUsername: string })[];
  nextCursor: number | null; // pass as `before` to fetch the next-older page
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function listMessages(
  conversationId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // Newest-first index scan on (conversation_id, id); limit+1 detects whether
  // an older page exists without a separate COUNT.
  const params: unknown[] = [conversationId];
  let cursor = '';
  if (opts.before) {
    cursor = 'AND m.id < ?';
    params.push(opts.before);
  }
  params.push(limit + 1);
  const [rows] = (await pool.query(
    `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId,
            m.created_at AS createdAt, u.username AS senderUsername
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ${cursor}
     ORDER BY m.id DESC
     LIMIT ?`,
    params,
  )) as unknown as [(Message & { senderUsername: string })[]];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse(); // ascending for display

  const ids = page.map((m) => m.id);
  const bodies = ids.length
    ? await mongo()
        .collection('message_bodies')
        .find({ _id: { $in: ids as never[] } })
        .toArray()
    : [];
  const bodyById = new Map(bodies.map((b) => [b._id as unknown as number, b.body as string]));

  return {
    messages: page.map((m) => ({ ...m, body: bodyById.get(m.id) ?? '' })),
    nextCursor: hasMore && page.length ? page[0].id : null,
  };
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
