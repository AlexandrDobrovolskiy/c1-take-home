import express from 'express';
import { config } from '../config.ts';
import { createMessage, listMessages } from '../services/messages.ts';
import { isParticipant } from '../services/participants.ts';
import { broadcast } from '../ws/hub.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { wrap } from '../lib/wrap.ts';
import { messagesSent } from '../metrics.ts';

const MAX_BODY_LENGTH = 4000;

export const messagesRouter = express.Router();

// Per user per conversation, so one noisy sender can't throttle anyone else
// (and can still talk in their other conversations).
const sendLimiter = rateLimit({
  ...config.sendRate,
  key: (req) => `send:${req.user.uid}:${Number(req.body?.conversationId)}`,
});

messagesRouter.post(
  '/',
  sendLimiter,
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
    await broadcast(out.conversationId, { type: 'message', ...out });
    messagesSent.inc();
    res.status(201).json(out);
  }),
);

// GET /api/messages?conversationId=X[&limit=50][&before=<id>]
// Returns { messages: [...ascending...], nextCursor } — pass nextCursor as
// `before` to page backward through history.
messagesRouter.get(
  '/',
  wrap(async (req, res) => {
    const conversationId = Number(req.query.conversationId);
    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const before = req.query.before !== undefined ? Number(req.query.before) : undefined;
    if ((limit !== undefined && !Number.isInteger(limit)) ||
        (before !== undefined && !(Number.isInteger(before) && before > 0))) {
      return res.status(400).json({ error: 'limit and before must be positive integers' });
    }
    if (!(await isParticipant(conversationId, req.user.uid))) {
      return res.status(403).json({ error: 'not a participant of this conversation' });
    }

    res.json(await listMessages(conversationId, { limit, before }));
  }),
);
