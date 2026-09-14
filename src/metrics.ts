import client from 'prom-client';
import type { NextFunction, Request, Response } from 'express';

// Per-instance metrics, scraped by Prometheus at /metrics (internal network
// only — Envoy blocks the path at the public edge). Route labels are the
// app's fixed API paths (ids travel in query strings), so cardinality is safe.

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

const httpRequests = new client.Counter({
  name: 'relay_http_requests_total',
  help: 'HTTP requests handled',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: 'relay_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['route'],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const wsConnections = new client.Gauge({
  name: 'relay_ws_connections',
  help: 'Open authenticated WebSocket connections',
  registers: [registry],
});

export const messagesSent = new client.Counter({
  name: 'relay_messages_sent_total',
  help: 'Messages accepted and fully processed (201)',
  registers: [registry],
});

export const wsDelivered = new client.Counter({
  name: 'relay_ws_delivered_total',
  help: 'Events delivered to local WebSocket subscribers',
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'relay_rate_limited_total',
  help: 'Requests rejected with 429',
  labelNames: ['limiter'],
  registers: [registry],
});

function routeLabel(req: Request): string {
  if (req.path === '/metrics') return '/metrics';
  if (req.path.startsWith('/api/')) return req.path;
  return 'static';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // capture the label now — Express rewrites req.url while dispatching into
  // mounted routers, so req.path is unreliable by the time 'finish' fires
  const route = routeLabel(req);
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    stop({ route });
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
}
