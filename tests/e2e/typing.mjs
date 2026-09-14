// E2E: typing indicator fan-out and authorization.
// Run inside the compose network:  docker compose exec api node tests/e2e/typing.mjs
//
// alice + bob are in conversation 1; carol is in conversation 2 only.
// Asserts: bob sees alice typing in conv 1; carol (not subscribed to conv 1)
// sees nothing; and bob CANNOT spoof typing into conv 2 (he is not a member),
// so carol sees nothing from him either.

import WebSocket from 'ws';

const BASE = process.env.E2E_BASE ?? 'http://envoy:3000';
const WS_BASE = BASE.replace('http', 'ws');

async function login(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo' }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

function openClient(cookie, conversationIds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/`, { headers: { Cookie: cookie } });
    const typing = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', conversationIds }));
      setTimeout(() => resolve({ ws, typing }), 300);
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'typing') typing.push(m);
    });
    ws.on('error', reject);
  });
}

const [aliceCookie, bobCookie, carolCookie] = await Promise.all(
  ['alice', 'bob', 'carol'].map(login),
);
const alice = await openClient(aliceCookie, [1]);
const bob = await openClient(bobCookie, [1]);
const carol = await openClient(carolCookie, [2]);

// 1. alice types in conv 1 -> bob must see it
alice.ws.send(JSON.stringify({ type: 'typing', conversationId: 1 }));
// 2. bob tries to spoof typing into conv 2 (he is NOT a member)
bob.ws.send(JSON.stringify({ type: 'typing', conversationId: 2 }));
await new Promise((r) => setTimeout(r, 1200));

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`);
  if (!ok) failed = true;
};

check('bob sees "alice" typing in conv 1', bob.typing.some((t) => t.conversationId === 1 && t.username === 'alice'));
check('carol (not in conv 1) sees nothing', carol.typing.length === 0);
check("bob's spoofed typing into conv 2 was dropped", !carol.typing.some((t) => t.conversationId === 2));

for (const c of [alice, bob, carol]) c.ws.close();
console.log(failed ? 'FAIL' : 'PASS: typing indicator fan-out + authorization');
process.exit(failed ? 1 : 0);
