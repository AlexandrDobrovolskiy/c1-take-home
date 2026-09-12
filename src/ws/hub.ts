import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { verifyToken } from '../auth/tokens.ts';
import { tokenFromCookies } from '../auth/middleware.ts';
import { participantConversations } from '../services/participants.ts';

type Client = WebSocket & { subs?: Set<number>; userId?: number };

const clients = new Set<Client>();

export function attachWs(server: Server): void {
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
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

export function broadcast(conversationId: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
