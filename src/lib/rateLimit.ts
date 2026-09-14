import type { Request, RequestHandler } from 'express';
import { redisLimiter } from '../db/redis.ts';
import { rateLimited } from '../metrics.ts';
import { wrap } from './wrap.ts';

// Token bucket in Redis, evaluated atomically as a Lua script: state lives in
// one place, so the limit holds across any number of API instances, and the
// read-refill-consume step can't race concurrent requests (unlike a GET/SET
// round trip). Compared to a fixed INCR window, a bucket allows a small burst
// (capacity) but enforces the sustained rate smoothly — no 2x bursts at
// window boundaries.
//
// KEYS[1] bucket key; ARGV: capacity, refill/sec, cost.
// Time comes from Redis itself (TIME) — one clock for every replica, so
// cross-instance clock skew can't rewind buckets or mint free tokens.
// Returns {allowed 0|1, retry_after_ms}.
const TOKEN_BUCKET = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local tokens = tonumber(redis.call('HGET', KEYS[1], 't'))
local ts = tonumber(redis.call('HGET', KEYS[1], 'ms'))
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
if tokens == nil then tokens = capacity ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) / 1000 * rate)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 't', tokens, 'ms', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 2000))
return {allowed, retry_ms}
`;

let scriptSha: string | null = null;

export interface RateLimitOptions {
  capacity: number; // burst size
  refillPerSec: number; // sustained rate
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterS: number;
}

export async function consume(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  const args = [String(opts.capacity), String(opts.refillPerSec), String(opts.cost ?? 1)];
  scriptSha ??= await redisLimiter.scriptLoad(TOKEN_BUCKET);
  let reply: unknown;
  try {
    reply = await redisLimiter.evalSha(scriptSha, { keys: [`rl:${key}`], arguments: args });
  } catch (err) {
    if (!String(err).includes('NOSCRIPT')) throw err; // e.g. Redis restarted with an empty script cache
    scriptSha = await redisLimiter.scriptLoad(TOKEN_BUCKET);
    reply = await redisLimiter.evalSha(scriptSha, { keys: [`rl:${key}`], arguments: args });
  }
  const [allowed, retryMs] = reply as [number, number];
  return { allowed: allowed === 1, retryAfterS: retryMs / 1000 };
}

// Express middleware. Default fails OPEN: if Redis is unreachable the request
// goes through with a logged error — the limiter is protection, not a
// dependency worth taking the product down for. Security-sensitive routes
// (login) pass failMode: 'closed' — a brute-force control that vanishes under
// infrastructure stress is exactly what an attacker wants.
export function rateLimit(
  opts: RateLimitOptions & { key: (req: Request) => string; failMode?: 'open' | 'closed' },
): RequestHandler {
  return wrap(async (req, res, next) => {
    const key = opts.key(req);
    let result: RateLimitResult;
    try {
      result = await consume(key, opts);
    } catch (err) {
      if (opts.failMode === 'closed') {
        console.error('rate limiter unavailable, refusing request:', err);
        return res.status(503).json({ error: 'temporarily unavailable, retry shortly' });
      }
      console.error('rate limiter unavailable, allowing request:', err);
      return next();
    }
    if (!result.allowed) {
      rateLimited.inc({ limiter: key.split(':', 1)[0] });
      res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterS))));
      return res.status(429).json({ error: 'rate limit exceeded, retry later' });
    }
    next();
  });
}
