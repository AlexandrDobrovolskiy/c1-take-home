import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';

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

interface BodyDoc {
  _id: number;
  conversationId: number;
  senderId: number;
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

  const bodies = mongo().collection<BodyDoc>('message_bodies');

  // Primary: text index — indexed word/stem matching ranked by relevance,
  // newest first among equals.
  let docs = await bodies
    .find(
      { $text: { $search: q }, conversationId: { $in: ids } },
      { projection: { score: { $meta: 'textScore' }, conversationId: 1, senderId: 1, body: 1, createdAt: 1 } },
    )
    .sort({ score: { $meta: 'textScore' }, _id: -1 })
    .limit(limit)
    .toArray();

  // Fallback for what a word index can't match (partial words like "phoen").
  // Bounded: index-scoped to the user's conversations and capped at `limit`.
  if (docs.length === 0) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    docs = await bodies
      .find({ conversationId: { $in: ids }, body: { $regex: escaped, $options: 'i' } })
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
  }

  // Resolve sender usernames in one round trip.
  const senderIds = [...new Set(docs.map((d) => d.senderId))];
  const usernameById = new Map<number, string>();
  if (senderIds.length) {
    const [users] = (await pool.query('SELECT id, username FROM users WHERE id IN (?)', [
      senderIds,
    ])) as unknown as [{ id: number; username: string }[]];
    for (const u of users) usernameById.set(u.id, u.username);
  }

  return {
    conversations,
    messages: docs.map((d) => ({
      messageId: d._id,
      conversationId: d.conversationId,
      conversationTitle: titleById.get(d.conversationId) ?? `#${d.conversationId}`,
      senderUsername: usernameById.get(d.senderId) ?? `#${d.senderId}`,
      body: d.body,
      createdAt: d.createdAt,
    })),
  };
}
