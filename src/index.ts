import http from 'node:http';
import os from 'node:os';
import express from 'express';
import { config } from './config.ts';
import { waitForMysql } from './db/mysql.ts';
import { connectRedis } from './db/redis.ts';
import { requireAuth } from './auth/middleware.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { searchRouter } from './routes/search.js';
import { attachWs, startFanout } from './ws/hub.ts';
import { metricsHandler, metricsMiddleware } from './metrics.ts';

// Which replica served a request — useful when running multiple instances.
const INSTANCE = os.hostname();

const app = express();
app.set('trust proxy', true); // behind Envoy — req.ip comes from X-Forwarded-For
app.use((_req, res, next) => {
  res.set('X-Instance', INSTANCE);
  next();
});
app.use(metricsMiddleware);
// Scraped by Prometheus over the internal network; Envoy 404s it at the edge.
app.get('/metrics', metricsHandler);
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

await waitForMysql();
await connectRedis();
await startFanout();

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (instance ${INSTANCE})`);
});
