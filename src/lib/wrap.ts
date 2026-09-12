import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 does not catch rejected promises from async handlers; on modern
// Node an unhandled rejection kills the process. Route errors instead flow to
// the JSON error middleware in index.ts.
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
