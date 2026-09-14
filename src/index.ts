import http from 'node:http';
import os from 'node:os';
import express from 'express';
import { config } from './config.ts';
import { pool, waitForMysql } from './db/mysql.ts';
import { closeRedis, connectRedis } from './db/redis.ts';
import { requireAuth } from './auth/middleware.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { searchRouter } from './routes/search.js';
import { attachWs, shutdownWs, startFanout } from './ws/hub.ts';
import { metricsHandler, metricsMiddleware } from './metrics.ts';

// Which replica served a request — useful when running multiple instances.
const INSTANCE = os.hostname();

const app = express();
// Exactly one trusted hop (Envoy, which appends the real client address to
// XFF via use_remote_address). `true` here would trust attacker-supplied XFF.
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set('X-Instance', INSTANCE);
  next();
});
app.use(metricsMiddleware);
app.use(express.json());
app.use(express.static('web'));

app.use('/api/auth', authRouter);
app.use('/api', requireAuth); // everything below requires a valid token
app.use('/api/conversations', conversationsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);

// Central JSON error handler — route errors land here via wrap() instead of
// becoming process-killing unhandled rejections.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
attachWs(server);

// Metrics on a separate internal-only port: Envoy never routes to it, so no
// edge path-matching (case tricks, trailing slashes) can expose it.
const metricsServer = http.createServer((req, res) => {
  if (req.url?.split('?')[0] === '/metrics') {
    metricsHandler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  } else {
    res.statusCode = 404;
    res.end();
  }
});

await waitForMysql();
await connectRedis();
await startFanout();

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (instance ${INSTANCE})`);
});
metricsServer.listen(config.metricsPort);

// Graceful drain: stop accepting, close WS clients (they reconnect to the
// surviving replicas), finish in-flight requests, then release connections.
// Without this, every scale-down or redeploy hard-drops live traffic.
function shutdown(signal: string): void {
  console.log(`${signal} received — draining (instance ${INSTANCE})`);
  metricsServer.close();
  server.close(() => {
    Promise.allSettled([pool.end(), closeRedis()]).then(() => process.exit(0));
  });
  shutdownWs();
  setTimeout(() => process.exit(1), 8_000).unref(); // hard deadline
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
