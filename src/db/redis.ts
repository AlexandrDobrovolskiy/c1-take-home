import { createClient } from 'redis';
import { config } from '../config.ts';

// Two connections: a Redis connection in subscriber mode can't issue regular
// commands, so pub and sub must be separate. node-redis reconnects with
// backoff automatically and re-subscribes the subscriber after a reconnect.
export const redisPub = createClient({ url: config.redisUrl });
export const redisSub = redisPub.duplicate();

export async function connectRedis(): Promise<void> {
  // without an error listener, a dropped connection throws uncaught
  redisPub.on('error', (err) => console.error('redis pub:', err.message));
  redisSub.on('error', (err) => console.error('redis sub:', err.message));
  await Promise.all([redisPub.connect(), redisSub.connect()]);
}

export async function closeRedis(): Promise<void> {
  await Promise.all([redisPub.close(), redisSub.close()]);
}
