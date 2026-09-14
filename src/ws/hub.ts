import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { verifyToken } from '../auth/tokens.ts';
import { tokenFromCookies } from '../auth/middleware.ts';
import { participantConversations } from '../services/participants.ts';
import { redisPub, redisSub } from '../db/redis.ts';
import { wsConnections, wsDelivered } from '../metrics.ts';

type Client = WebSocket & {
  subs?: Set<number>;
  userId?: number;
  username?: string;
  isAlive?: boolean;
  lastTypingAt?: Map<number, number>;
  subSeq?: number;
};

const clients = new Set<Client>();
// Delivery indexes: events cost O(recipients), not O(all sockets on the instance).
const byConversation = new Map<number, Set<Client>>();
const byUser = new Map<number, Set<Client>>();

const HEARTBEAT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 200; // per socket — also caps the membership IN(...) query
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // slow-consumer cutoff: terminate, client resyncs

// All realtime events flow through Redis pub/sub so they reach sockets on
// every API instance. One shared channel; each instance delivers to its own
// indexed sockets. See docs/multi-instance.md for the scale-up path.
const CHANNEL = 'relay:events';

interface FanoutEvent {
  conversationId?: number; // deliver to sockets subscribed to this conversation
  userIds?: number[]; // and/or to all sockets of these users (membership events)
  payload: unknown;
}

function indexAdd(map: Map<number, Set<Client>>, key: number, ws: Client): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(ws);
}

function indexRemove(map: Map<number, Set<Client>>, key: number, ws: Client): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(key);
}

function setSubscriptions(ws: Client, next: Set<number>): void {
  for (const id of ws.subs ?? []) if (!next.has(id)) indexRemove(byConversation, id, ws);
  for (const id of next) if (!ws.subs?.has(id)) indexAdd(byConversation, id, ws);
  ws.subs = next;
}

function sendTo(ws: Client, data: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    // A consumer that can't keep up would buffer unboundedly on our heap;
    // cut it off — the client's reconnect/resync path recovers the state.
    ws.terminate();
    return;
  }
  ws.send(data);
  wsDelivered.inc();
}

function deliverLocal(evt: FanoutEvent): void {
  const data = JSON.stringify(evt.payload);
  const targets = new Set<Client>();
  if (evt.conversationId !== undefined) {
    for (const ws of byConversation.get(evt.conversationId) ?? []) targets.add(ws);
  }
  for (const uid of evt.userIds ?? []) {
    for (const ws of byUser.get(uid) ?? []) targets.add(ws);
  }
  for (const ws of targets) sendTo(ws, data);
}

// Subscribe this instance to the fan-out channel. Called once at startup.
export async function startFanout(): Promise<void> {
  await redisSub.subscribe(CHANNEL, (raw: string) => {
    try {
      deliverLocal(JSON.parse(raw) as FanoutEvent);
    } catch {
      /* ignore malformed events */
    }
  });
}

async function publish(evt: FanoutEvent): Promise<void> {
  try {
    await redisPub.publish(CHANNEL, JSON.stringify(evt));
  } catch (err) {
    console.error('redis publish failed, delivering locally only:', err);
    deliverLocal(evt);
  }
}

// Publish an event for every instance (including this one — a single uniform
// delivery path). If Redis is down we degrade to local-only delivery rather
// than dropping the event entirely.
export async function broadcast(conversationId: number, payload: unknown): Promise<void> {
  await publish({ conversationId, payload });
}

// Target users directly (e.g. "you were added to a conversation") — reaches
// their sockets even though nobody is subscribed to the new conversation yet.
export async function broadcastToUsers(userIds: number[], payload: unknown): Promise<void> {
  await publish({ userIds, payload });
}

// Close every socket for shutdown; clients reconnect to surviving replicas.
export function shutdownWs(): void {
  for (const ws of clients) ws.close(1001, 'server shutting down');
}

export function attachWs(server: Server): void {
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  // Dead peers (network drop, killed tab) never send a close frame — without
  // pings their sockets would sit in the indexes forever.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate(); // triggers 'close' -> removed from indexes
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
    ws.username = payload.username;
    ws.subs = new Set();
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    clients.add(ws);
    indexAdd(byUser, ws.userId, ws);
    wsConnections.inc();

    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'subscribe' && Array.isArray(m.conversationIds)) {
          const requested = [...new Set<number>(m.conversationIds.map(Number))]
            .filter(Number.isInteger)
            .slice(0, MAX_SUBSCRIPTIONS);
          // Serialize concurrent subscribe frames: only the latest may win,
          // regardless of DB-query completion order.
          const seq = (ws.subSeq = (ws.subSeq ?? 0) + 1);
          const member = requested.length
            ? await participantConversations(ws.userId!, requested)
            : [];
          if (seq !== ws.subSeq) return; // superseded by a newer frame
          setSubscriptions(ws, new Set(member));
          // ACK so the client knows delivery is live before it fetches history
          // (closes the connect→subscribe message-loss window).
          ws.send(JSON.stringify({ type: 'subscribed', conversationIds: member }));
        } else if (m.type === 'typing') {
          // Ephemeral event — `subs` only ever contains membership-verified
          // ids, so it doubles as the authorization check (no DB hit).
          const convId = Number(m.conversationId);
          if (!ws.subs?.has(convId)) return;
          const now = Date.now();
          ws.lastTypingAt ??= new Map();
          if (now - (ws.lastTypingAt.get(convId) ?? 0) < 1000) return; // spam guard
          ws.lastTypingAt.set(convId, now);
          await broadcast(convId, {
            type: 'typing',
            conversationId: convId,
            userId: ws.userId,
            username: ws.username,
          });
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      setSubscriptions(ws, new Set());
      indexRemove(byUser, ws.userId!, ws);
      wsConnections.dec();
    });
  });
}
