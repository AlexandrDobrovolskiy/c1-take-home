import crypto from 'node:crypto';
import { config } from '../config.ts';

// Stateless HMAC-SHA256 signed token: base64url(payload).base64url(mac).
// Verification is pure CPU (no DB/Redis hit) and needs only the shared
// AUTH_SECRET, so it scales across instances. Trade-off: no server-side
// revocation before `exp` — see docs/auth.md.

export interface TokenPayload {
  uid: number;
  name: string;
  username: string;
  exp: number; // unix seconds
}

export function signToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.authSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', config.authSecret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (!Number.isInteger(payload.uid) || typeof payload.exp !== 'number') return null;
    if (typeof payload.username !== 'string') return null;
    if (payload.exp <= Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
