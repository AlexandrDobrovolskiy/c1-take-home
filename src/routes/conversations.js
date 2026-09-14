import express from 'express';
import { pool } from '../db/mysql.ts';
import { listConversations } from '../services/conversations.ts';
import { broadcastToUsers } from '../ws/hub.ts';
import { wrap } from '../lib/wrap.ts';

const MAX_TITLE_LENGTH = 200;

export const conversationsRouter = express.Router();

conversationsRouter.get(
  '/',
  wrap(async (req, res) => {
    res.json(await listConversations(req.user.uid));
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

    // Tell every participant's live sockets — otherwise invitees get no
    // realtime for the new conversation until they reload.
    await broadcastToUsers([...participantIds], { type: 'conversation', id, title });

    res.status(201).json({ id, title, participantIds: [...participantIds] });
  }),
);
