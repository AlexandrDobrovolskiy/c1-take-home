import { pool } from '../db/mysql.ts';

// Telegram-style unified search: one query fans out to conversation titles and
// message bodies, results come back grouped. Everything is scoped to the
// user's own conversations *inside the queries*, so authorization can't be
// bypassed by crafted input.

export interface SearchResults {
  conversations: { id: number; title: string }[];
  messages: {
    messageId: number;
    conversationId: number;
    conversationTitle: string;
    senderUsername: string;
    body: string;
    createdAt: Date;
  }[];
}

interface Row {
  id: number;
  conversationId: number;
  senderId: number;
  senderUsername: string;
  body: string;
  createdAt: Date;
}

export async function searchAll(userId: number, q: string, limit = 20): Promise<SearchResults> {
  // The user's conversations: the authorization boundary for everything below,
  // and the source of titles for both result groups. Small per-user set.
  const [convs] = (await pool.query(
    `SELECT c.id, c.title
     FROM conversations c
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ?`,
    [userId],
  )) as unknown as [{ id: number; title: string }[]];
  if (convs.length === 0) return { conversations: [], messages: [] };

  const titleById = new Map(convs.map((c) => [c.id, c.title]));
  const ids = [...titleById.keys()];
  const needle = q.toLowerCase();
  const conversations = convs.filter((c) => c.title.toLowerCase().includes(needle)).slice(0, limit);

  // Primary: FULLTEXT — indexed word/stem matching ranked by relevance,
  // newest first among equals.
  let [rows] = (await pool.query(
    `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId,
            m.body, m.created_at AS createdAt, u.username AS senderUsername,
            MATCH(m.body) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id IN (?)
       AND MATCH(m.body) AGAINST (? IN NATURAL LANGUAGE MODE)
     ORDER BY score DESC, m.id DESC
     LIMIT ?`,
    [q, ids, q, limit],
  )) as unknown as [Row[]];

  // Fallback for what a word index can't match (partial words like "phoen").
  // Bounded: index-scoped to the user's conversations and capped at `limit`.
  if (rows.length === 0) {
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    [rows] = (await pool.query(
      `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId,
              m.body, m.created_at AS createdAt, u.username AS senderUsername
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id IN (?) AND m.body LIKE ?
       ORDER BY m.id DESC
       LIMIT ?`,
      [ids, `%${escaped}%`, limit],
    )) as unknown as [Row[]];
  }

  return {
    conversations,
    messages: rows.map((r) => ({
      messageId: r.id,
      conversationId: r.conversationId,
      conversationTitle: titleById.get(r.conversationId) ?? `#${r.conversationId}`,
      senderUsername: r.senderUsername,
      body: r.body,
      createdAt: r.createdAt,
    })),
  };
}
