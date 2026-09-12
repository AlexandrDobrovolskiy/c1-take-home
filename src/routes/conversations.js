import express from 'express';
import { pool } from '../db/mysql.ts';
import { wrap } from '../lib/wrap.ts';

const MAX_TITLE_LENGTH = 200;

export const conversationsRouter = express.Router();

conversationsRouter.get(
  '/',
  wrap(async (req, res) => {
    const userId = req.user.uid;

    const [conversations] = await pool.query(
      `SELECT c.id, c.title
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id
       WHERE p.user_id = ?
       ORDER BY c.id ASC`,
      [userId],
    );

    const result = [];
    for (const c of conversations) {
      const [[last]] = await pool.query(
        `SELECT id, sender_id AS senderId, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`,
        [c.id],
      );
      const [[counted]] = await pool.query(
        'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
        [c.id],
      );
      result.push({ ...c, lastMessage: last || null, messageCount: counted.count });
    }

    res.json(result);
  }),
);

conversationsRouter.post(
  '/',
  wrap(async (req, res) => {
    const { title, participantUsernames } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ error: `title is required (max ${MAX_TITLE_LENGTH} chars)` });
    }
    const usernames = Array.isArray(participantUsernames)
      ? [...new Set(participantUsernames.map(String))]
      : [];

    // The creator is always a participant; invitees are resolved by username
    // so the client never supplies raw user ids.
    const participantIds = new Set([req.user.uid]);
    if (usernames.length) {
      const [users] = await pool.query('SELECT id, username FROM users WHERE username IN (?)', [
        usernames,
      ]);
      if (users.length !== usernames.length) {
        const found = new Set(users.map((u) => u.username));
        const unknown = usernames.filter((u) => !found.has(u));
        return res.status(400).json({ error: `unknown username(s): ${unknown.join(', ')}` });
      }
      for (const u of users) participantIds.add(u.id);
    }

    const conn = await pool.getConnection();
    let id;
    try {
      await conn.beginTransaction();
      const [created] = await conn.execute('INSERT INTO conversations (title) VALUES (?)', [title]);
      id = created.insertId;
      await conn.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ?', [
        [...participantIds].map((uid) => [id, uid]),
      ]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.status(201).json({ id, title, participantIds: [...participantIds] });
  }),
);
