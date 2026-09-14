// k6 load test for Relay — run against the ISOLATED stack (see
// docker-compose.loadtest.yml header for the exact commands).
//
// Scenarios:
//   reads   — inbox listing + history page + occasional search (the hot path)
//   sends   — paced message sending within the rate limit (fan-out load)
//   abuse   — one user hammering sends with no pacing: must get 429s, not 5xxs
//   sockets — persistent WebSocket subscribers receiving the fan-out
//
// HEAVY=1 doubles the pressure (spike to 300 read VUs).

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://envoy:3000';
const USERS = Number(__ENV.USERS || 50);
const HEAVY = __ENV.HEAVY === '1';
const WORDS = ['order', 'delivery', 'update', 'tracking', 'invoice', 'schedule', 'design', 'launch', 'metrics', 'summary'];

// 429 is a correct answer from the rate limiter, not a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));

const wsMessages = new Counter('ws_messages_received');
const throttled = new Counter('sends_throttled_429');
const sendOk = new Rate('send_success');

export const options = {
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    reads: {
      executor: 'ramping-vus',
      exec: 'reads',
      stages: HEAVY
        ? [
            { duration: '30s', target: 150 },
            { duration: '60s', target: 150 },
            { duration: '20s', target: 300 },
            { duration: '60s', target: 300 },
            { duration: '10s', target: 0 },
          ]
        : [
            { duration: '30s', target: 100 },
            { duration: '90s', target: 100 },
            { duration: '10s', target: 0 },
          ],
    },
    sends: { executor: 'constant-vus', exec: 'sends', vus: 20, duration: HEAVY ? '3m' : '2m' },
    abuse: { executor: 'constant-vus', exec: 'abuse', vus: 5, duration: '30s', startTime: '45s' },
    sockets: { executor: 'constant-vus', exec: 'sockets', vus: 100, duration: HEAVY ? '3m' : '2m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.98'],
    'http_req_duration{name:conversations}': ['p(95)<250'],
    'http_req_duration{name:history}': ['p(95)<300'],
    'http_req_duration{name:send}': ['p(95)<300'],
    'http_req_duration{name:search}': ['p(95)<300'],
  },
};

export function setup() {
  const cookies = [];
  for (let i = 1; i <= USERS; i++) {
    let token = null;
    for (let attempt = 0; attempt < 5 && !token; attempt++) {
      const res = http.post(
        `${BASE}/api/auth/login`,
        JSON.stringify({ username: `loaduser${i}`, password: 'load' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
      if (res.status === 200) token = res.cookies.relay_token[0].value;
      else sleep(1);
    }
    if (!token) throw new Error(`could not log in loaduser${i} — did tests/load/seed.mts run?`);
    cookies.push(token);
  }
  return { cookies };
}

function auth(data, idx, name) {
  return {
    headers: { 'Content-Type': 'application/json', Cookie: `relay_token=${data.cookies[idx]}` },
    tags: { name },
  };
}
const userIdx = () => (__VU - 1) % USERS;

let myConv = null; // per-VU cache of the VU's own conversation id
function convOf(data, idx) {
  if (myConv) return myConv;
  const res = http.get(`${BASE}/api/conversations`, auth(data, idx, 'conversations'));
  const list = res.status === 200 ? JSON.parse(res.body) : [];
  myConv = list.length ? list[list.length - 1].id : null; // last = their load conv
  return myConv;
}

export function reads(data) {
  const idx = userIdx();
  const listRes = http.get(`${BASE}/api/conversations`, auth(data, idx, 'conversations'));
  check(listRes, { 'inbox 200': (r) => r.status === 200 });
  const convs = listRes.status === 200 ? JSON.parse(listRes.body) : [];
  if (convs.length) {
    const cid = convs[convs.length - 1].id;
    const hist = http.get(`${BASE}/api/messages?conversationId=${cid}`, auth(data, idx, 'history'));
    check(hist, { 'history 200': (r) => r.status === 200 });
  }
  if (Math.random() < 0.15) {
    const q = WORDS[Math.floor(Math.random() * WORDS.length)];
    const s = http.get(`${BASE}/api/search?q=${q}`, auth(data, idx, 'search'));
    check(s, { 'search 200/429': (r) => r.status === 200 || r.status === 429 });
  }
  sleep(0.3 + Math.random() * 0.4);
}

export function sends(data) {
  const idx = userIdx();
  const cid = convOf(data, idx);
  if (!cid) return;
  const res = http.post(
    `${BASE}/api/messages`,
    JSON.stringify({
      conversationId: cid,
      body: `load ${WORDS[__ITER % WORDS.length]} vu${__VU} iter${__ITER}`,
      clientId: `k6-${__VU}-${__ITER}`,
    }),
    auth(data, idx, 'send'),
  );
  sendOk.add(res.status === 201);
  if (res.status === 429) throttled.add(1);
  check(res, { 'send 201/429': (r) => r.status === 201 || r.status === 429 });
  sleep(2.5 + Math.random());
}

// One user, zero pacing: the limiter must answer with 429s and the service
// must never turn that into 5xxs.
export function abuse(data) {
  const cid = convOf(data, 0);
  if (!cid) return;
  const res = http.post(
    `${BASE}/api/messages`,
    JSON.stringify({ conversationId: cid, body: 'flood', clientId: `k6-abuse-${__VU}-${__ITER}` }),
    auth(data, 0, 'abuse'),
  );
  if (res.status === 429) throttled.add(1);
  check(res, { 'abuse never 5xx': (r) => r.status < 500 });
}

export function sockets(data) {
  const idx = userIdx();
  const cid = convOf(data, idx);
  if (!cid) return;
  const res = ws.connect(
    `${BASE.replace('http', 'ws')}/`,
    { headers: { Cookie: `relay_token=${data.cookies[idx]}` } },
    (socket) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', conversationIds: [cid] })));
      socket.on('message', () => wsMessages.add(1));
      socket.setTimeout(() => socket.close(), 60_000);
    },
  );
  check(res, { 'ws upgraded': (r) => r && r.status === 101 });
}
