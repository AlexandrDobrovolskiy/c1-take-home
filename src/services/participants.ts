import { pool } from '../db/mysql.ts';

// PK lookup on (conversation_id, user_id) — O(1) per request. If membership
// checks ever dominate, they are trivially cacheable (Redis/in-process TTL).
export async function isParticipant(conversationId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
    [conversationId, userId],
  );
  return (rows as unknown[]).length > 0;
}

// Of the given conversation ids, return those the user actually belongs to.
export async function participantConversations(
  userId: number,
  conversationIds: number[],
): Promise<number[]> {
  if (conversationIds.length === 0) return [];
  const [rows] = await pool.query(
    'SELECT conversation_id AS id FROM conversation_participants WHERE user_id = ? AND conversation_id IN (?)',
    [userId, conversationIds],
  );
  return (rows as { id: number }[]).map((r) => r.id);
}
