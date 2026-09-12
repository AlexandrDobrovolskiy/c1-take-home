import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type TokenPayload } from './tokens.ts';

export const COOKIE_NAME = 'relay_token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: TokenPayload;
    }
  }
}

// Minimal cookie parse (we only ever read one cookie) — avoids a dependency.
export function tokenFromCookies(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const payload = verifyToken(tokenFromCookies(req.headers.cookie) ?? '');
  if (!payload) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  req.user = payload;
  next();
}
