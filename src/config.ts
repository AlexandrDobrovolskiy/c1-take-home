export const config = {
  port: Number(process.env.PORT) || 3000,
  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017/relay',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  // HMAC key for auth tokens. Must be identical on every instance; rotate to invalidate all sessions.
  authSecret: process.env.AUTH_SECRET || 'dev-only-secret-change-me',
  // Sends: burst of 5, refill 1 token / 2s — the task's "~5 messages per 10s".
  sendRate: {
    capacity: Number(process.env.SEND_RATE_CAPACITY) || 5,
    refillPerSec: Number(process.env.SEND_RATE_REFILL_PER_SEC) || 0.5,
  },
  // Login: brute-force deterrence per client IP.
  loginRate: {
    capacity: Number(process.env.LOGIN_RATE_CAPACITY) || 10,
    refillPerSec: Number(process.env.LOGIN_RATE_REFILL_PER_SEC) || 0.5,
  },
};
