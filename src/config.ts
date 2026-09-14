const DEV_SECRET = 'dev-only-secret-change-me';
const authSecret = process.env.AUTH_SECRET || DEV_SECRET;
if (authSecret === DEV_SECRET) {
  // A known secret means anyone can forge a valid session token for any user.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be set to a strong random value in production');
  }
  console.error('WARNING: running with the default AUTH_SECRET — tokens are forgeable. Dev only.');
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  metricsPort: Number(process.env.METRICS_PORT) || 9091,
  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  // HMAC key for auth tokens. Must be identical on every instance; rotate to invalidate all sessions.
  authSecret,
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
  // Search: generous enough for search-as-you-type, bounded per user.
  searchRate: {
    capacity: Number(process.env.SEARCH_RATE_CAPACITY) || 15,
    refillPerSec: Number(process.env.SEARCH_RATE_REFILL_PER_SEC) || 5,
  },
};
