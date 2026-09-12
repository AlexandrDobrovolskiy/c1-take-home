export const config = {
  port: Number(process.env.PORT) || 3000,
  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017/relay',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  // HMAC key for auth tokens. Must be identical on every instance; rotate to invalidate all sessions.
  authSecret: process.env.AUTH_SECRET || 'dev-only-secret-change-me',
};
