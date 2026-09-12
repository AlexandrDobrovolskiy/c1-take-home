import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { verifyToken } from '../auth/tokens.ts';
import { tokenFromCookies } from '../auth/middleware.ts';
import { participantConversations } from '../services/participants.ts';
import { redisPub, redisSub } from '../db/redis.ts';

type Client = WebSocket & { subs?: Set<number>; userId?: number; isAlive?: boolean };

const clients = new Set<Client>();

const HEARTBEAT_MS = 30_000;

// All realtime events flow through Redis pub/sub so they reach sockets on
// every API instance, not just the one that handled the HTTP request. One
// shared channel; each instance filters against its own sockets' subs. At much
// larger scale this shards naturally (per-conversation channels, or streams
// for replay) — see docs/multi-instance.md.
const CHANNEL = 'relay:events';

interface FanoutEvent {
  conversationId: number;
  payload: unknown;
}

// Subscribe this instance to the fan-out channel. Called once at startup.
export async function startFanout(): Promise<void> {
  await redisSub.subscribe(CHANNEL, (raw: string) => {
    try {
      const evt = JSON.parse(raw) as FanoutEvent;
      deliverLocal(evt.conversationId, JSON.stringify(evt.payload));
    } catch {
      /* ignore malformed events */
    }
  });
}

function deliverLocal(conversationId: number, data: string): void {
  for (const ws of clients) {
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function attachWs(server: Server): void {
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  // Dead peers (network drop, killed tab) never send a close frame — without
  // pings their sockets would sit in `clients` forever and broadcast would keep
  // writing into the void.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate(); // triggers 'close' -> removed from clients
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: Client, req: IncomingMessage) => {
    // The httpOnly auth cookie rides along on the upgrade request, so the
    // socket is authenticated with the same stateless token as HTTP.
    const payload = verifyToken(tokenFromCookies(req.headers.cookie) ?? '');
    if (!payload) {
      ws.close(4401, 'authentication required');
      return;
    }
    ws.userId = payload.uid;
    ws.subs = new Set();
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    clients.add(ws);
    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'subscribe' && Array.isArray(m.conversationIds)) {
          const requested = [...new Set<number>(m.conversationIds.map(Number))].filter(
            Number.isInteger,
          );
          // Only subscribe to conversations the user is actually a member of.
          ws.subs = new Set(await participantConversations(ws.userId!, requested));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => clients.delete(ws));
  });
}

// Publish an event for every instance (including this one — a single uniform
// delivery path instead of "local direct + remote via bus"). If Redis is down
// we degrade to local-only delivery rather than dropping the event entirely.
export async function broadcast(conversationId: number, payload: unknown): Promise<void> {
  const event: FanoutEvent = { conversationId, payload };
  try {
    await redisPub.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error('redis publish failed, delivering locally only:', err);
    deliverLocal(conversationId, JSON.stringify(payload));
  }
}
