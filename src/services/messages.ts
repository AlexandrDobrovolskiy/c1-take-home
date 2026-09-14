import { pool } from '../db/mysql.ts';

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
  // true when this call deduplicated a retry — the message already existed
  // (callers must not broadcast it again)
  deduped?: boolean;
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
            m.body, m.created_at AS createdAt, u.username AS senderUsername
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ${cursor}
     ORDER BY m.id DESC
     LIMIT ?`,
    params,
  )) as unknown as [(Message & { senderUsername: string })[]];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse(); // ascending for display

  return {
    messages: page,
    nextCursor: hasMore && page.length ? page[0].id : null,
  };
}

// One atomic insert — row and body commit or fail together. The unique index
// on (conversation_id, client_id) makes retries and concurrent duplicates
// converge on the original message.
export async function createMessage(input: NewMessage): Promise<Message> {
  const { conversationId, senderId, body, clientId } = input;

  try {
    const [res] = await pool.execute(
      'INSERT INTO messages (conversation_id, sender_id, client_id, body) VALUES (?, ?, ?, ?)',
      [conversationId, senderId, clientId, body],
    );
    const id = (res as { insertId: number }).insertId;
    return { id, conversationId, senderId, body, createdAt: new Date() };
  } catch (err) {
    if (clientId && (err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const [[row]] = (await pool.query(
        `SELECT id, sender_id AS senderId, body, created_at AS createdAt
         FROM messages WHERE conversation_id = ? AND client_id = ?`,
        [conversationId, clientId],
      )) as unknown as [{ id: number; senderId: number; body: string; createdAt: Date }[]];
      if (!row) throw err;
      // The original message wins — return it, flagged so it isn't re-broadcast.
      return {
        id: row.id,
        conversationId,
        senderId: row.senderId,
        body: row.body,
        createdAt: row.createdAt,
        deduped: true,
      };
    }
    throw err;
  }
}
