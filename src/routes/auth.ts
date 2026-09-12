import express from 'express';
import { config } from '../config.ts';
import { pool } from '../db/mysql.ts';
import { verifyPassword } from '../auth/passwords.ts';
import { signToken } from '../auth/tokens.ts';
import { COOKIE_NAME, requireAuth } from '../auth/middleware.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { wrap } from '../lib/wrap.ts';

const TOKEN_TTL_S = 7 * 24 * 3600;

// Verified when the username doesn't exist, so response time doesn't reveal
// which usernames are registered.
const DUMMY_HASH =
  '1c3f47a2255f589f851a877f912bfb8a:71b3ab39a56d5334b40c4bc9991093c56ad0ee2829c92566d602bd5a4e80f023';

export const authRouter = express.Router();

// Brute-force deterrence, keyed by client IP (Envoy sets X-Forwarded-For;
// `trust proxy` makes req.ip honor it).
const loginLimiter = rateLimit({ ...config.loginRate, key: (req) => `login:${req.ip}` });

authRouter.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const [[user]] = (await pool.query(
      'SELECT id, name, username, password_hash AS passwordHash FROM users WHERE username = ?',
      [username],
    )) as unknown as [{ id: number; name: string; username: string; passwordHash: string }[]];

    const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordOk) return res.status(401).json({ error: 'invalid credentials' });

    const token = signToken({
      uid: user.id,
      name: user.name,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
    });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: TOKEN_TTL_S * 1000,
    });
    res.json({ id: user.id, name: user.name, username: user.username });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.uid, name: req.user.name, username: req.user.username });
});
