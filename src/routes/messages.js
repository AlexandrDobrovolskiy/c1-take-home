import express from 'express';
import { createMessage } from '../services/messages.ts';
import { isParticipant } from '../services/participants.ts';
import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';
import { broadcast } from '../ws/hub.ts';
import { wrap } from '../lib/wrap.ts';

const MAX_BODY_LENGTH = 4000;

export const messagesRouter = express.Router();

messagesRouter.post(
  '/',
  wrap(async (req, res) => {
    const { conversationId, body, clientId } = req.body || {};
    const convId = Number(conversationId);
    if (!Number.isInteger(convId) || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'conversationId and a non-empty body are required' });
    }
    if (body.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ error: `body must be at most ${MAX_BODY_LENGTH} characters` });
    }
    // Sender identity comes from the auth token, never from the request body.
    if (!(await isParticipant(convId, req.user.uid))) {
      return res.status(403).json({ error: 'not a participant of this conversation' });
    }

    const msg = await createMessage({
      conversationId: convId,
      senderId: req.user.uid,
      body,
      clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : null,
    });

    // Sender username comes straight from the token — no extra lookup.
    const out = { ...msg, senderUsername: req.user.username };
    broadcast(out.conversationId, { type: 'message', ...out });
    res.status(201).json(out);
  }),
);

messagesRouter.get(
  '/',
  wrap(async (req, res) => {
    const conversationId = Number(req.query.conversationId);
    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    if (!(await isParticipant(conversationId, req.user.uid))) {
      return res.status(403).json({ error: 'not a participant of this conversation' });
    }

    const [rows] = await pool.query(
      `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId,
              m.created_at AS createdAt, u.username AS senderUsername
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.id ASC`,
      [conversationId],
    );

    const ids = rows.map((r) => r.id);
    const bodies = ids.length
      ? await mongo().collection('message_bodies').find({ _id: { $in: ids } }).toArray()
      : [];
    const bodyById = new Map(bodies.map((b) => [b._id, b.body]));

    res.json(rows.map((r) => ({ ...r, body: bodyById.get(r.id) ?? '' })));
  }),
);
