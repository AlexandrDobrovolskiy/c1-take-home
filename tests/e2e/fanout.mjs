// E2E: WebSocket fan-out across API instances.
//
// Requires the scaled stack: docker compose up -d --build (api has replicas: 3)
// Run inside the compose network:  docker compose exec api node tests/e2e/fanout.mjs
//
// Opens several WS clients through Envoy (round-robin lands them on different
// instances), posts one message over HTTP, and asserts every subscribed socket
// receives it — which only works if events fan out via Redis, not the
// in-process hub of whichever instance handled the POST.

import WebSocket from 'ws';

const BASE = process.env.E2E_BASE ?? 'http://envoy:3000';
const WS_BASE = BASE.replace('http', 'ws');
const CLIENTS = 4;
const CONVERSATION = 1; // seeded; alice and bob are participants

async function login(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo' }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, instance: res.headers.get('x-instance') };
}

function openClient(name, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/`, { headers: { Cookie: cookie } });
    const received = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', conversationIds: [CONVERSATION] }));
      setTimeout(() => resolve({ name, ws, received }), 300); // let subscribe land
    });
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    ws.on('error', reject);
  });
}

// Show that HTTP is actually load-balanced across instances.
const seen = new Set();
for (let i = 0; i < 12; i++) {
  const res = await fetch(`${BASE}/api/auth/me`);
  seen.add(res.headers.get('x-instance'));
}
console.log(`round-robin: ${seen.size} distinct instances over 12 requests [${[...seen].join(', ')}]`);

const alice = await login('alice');
const bob = await login('bob');
const clients = await Promise.all(
  Array.from({ length: CLIENTS }, (_, i) =>
    openClient(`client-${i}`, i % 2 === 0 ? alice.cookie : bob.cookie),
  ),
);

const body = `fanout proof ${Math.random().toString(36).slice(2, 8)}`;
const post = await fetch(`${BASE}/api/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
  body: JSON.stringify({ conversationId: CONVERSATION, body, clientId: `e2e-${Date.now()}` }),
});
if (post.status !== 201) throw new Error(`send failed: ${post.status}`);
console.log(`message posted via instance ${post.headers.get('x-instance')}`);

await new Promise((r) => setTimeout(r, 1500));

let failed = false;
for (const c of clients) {
  const got = c.received.some((m) => m.type === 'message' && m.body === body);
  console.log(`${c.name}: ${got ? 'received' : 'MISSED'}`);
  if (!got) failed = true;
  c.ws.close();
}

if (seen.size < 2) {
  console.error('WARNING: all requests hit one instance — is the stack scaled? (docker compose up -d --scale api=3)');
  failed = true;
}
console.log(failed ? 'FAIL: fan-out broken across instances' : `PASS: all ${CLIENTS} sockets received the message`);
process.exit(failed ? 1 : 0);
