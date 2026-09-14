import express from 'express';
import { config } from '../config.ts';
import { searchAll } from '../services/search.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { wrap } from '../lib/wrap.ts';

export const searchRouter = express.Router();

// Search-as-you-type friendly but bounded per user.
const searchLimiter = rateLimit({
  ...config.searchRate,
  key: (req) => `search:${req.user.uid}`,
});

// GET /api/search?q=... -> { conversations: [...], messages: [...] }
searchRouter.get(
  '/',
  searchLimiter,
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ conversations: [], messages: [] });
    res.json(await searchAll(req.user.uid, q));
  }),
);
