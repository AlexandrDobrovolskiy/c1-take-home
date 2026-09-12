import { pool } from '../db/mysql.ts';

export interface ConversationSummary {
  id: number;
  title: string;
  lastMessage: { id: number; senderId: number; createdAt: Date } | null;
  messageCount: number;
}

interface Row {
  id: number;
  title: string;
  messageCount: number;
  lastMessageId: number | null;
  lastSenderId: number | null;
  lastCreatedAt: Date | null;
}

export async function listConversations(userId: number): Promise<ConversationSummary[]> {
  // One round trip for the whole inbox. The LATERAL subquery is an index-only
  // range on idx_messages_conversation per conversation (count + max id), so
  // cost tracks the user's conversation count, not total messages in the table.
  const [rows] = (await pool.query(
    `SELECT c.id, c.title,
            agg.cnt AS messageCount,
            last.id AS lastMessageId,
            last.sender_id AS lastSenderId,
            last.created_at AS lastCreatedAt
     FROM conversation_participants p
     JOIN conversations c ON c.id = p.conversation_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS cnt, MAX(m.id) AS last_id
       FROM messages m
       WHERE m.conversation_id = c.id
     ) agg ON TRUE
     LEFT JOIN messages last ON last.id = agg.last_id
     WHERE p.user_id = ?
     ORDER BY c.id ASC`,
    [userId],
  )) as unknown as [Row[]];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastMessage:
      r.lastMessageId !== null
        ? { id: r.lastMessageId, senderId: r.lastSenderId!, createdAt: r.lastCreatedAt! }
        : null,
    messageCount: r.messageCount,
  }));
}
