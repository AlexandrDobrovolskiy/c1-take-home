import { createClient } from 'redis';
import { config } from '../config.ts';

// Three connections, one per concern:
// - a connection in subscriber mode can't issue regular commands (sub),
// - and the rate limiter's EVALs get their own socket so limiter traffic and
//   fan-out PUBLISHes never head-of-line block each other (pub vs limiter).
// node-redis reconnects with backoff automatically and re-subscribes the
// subscriber after a reconnect.
export const redisPub = createClient({ url: config.redisUrl });
export const redisSub = redisPub.duplicate();
export const redisLimiter = redisPub.duplicate();

export async function connectRedis(): Promise<void> {
  // without an error listener, a dropped connection throws uncaught
  redisPub.on('error', (err) => console.error('redis pub:', err.message));
  redisSub.on('error', (err) => console.error('redis sub:', err.message));
  redisLimiter.on('error', (err) => console.error('redis limiter:', err.message));
  await Promise.all([redisPub.connect(), redisSub.connect(), redisLimiter.connect()]);
}

export async function closeRedis(): Promise<void> {
  await Promise.all([redisPub.close(), redisSub.close(), redisLimiter.close()]);
}
