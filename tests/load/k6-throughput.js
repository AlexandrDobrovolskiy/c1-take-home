// Write-path throughput test: every request is a REAL message send that must
// be fully processed (rate-limiter Lua check -> membership check -> MySQL
// insert -> Mongo body insert -> Redis publish -> WS fan-out). No 429s: run
// the isolated stack with send limits raised (see docker-compose.loadtest.yml)
// — the limiter still executes per request, it just never rejects.
//
//   SEND_RATE_CAPACITY=1000000 SEND_RATE_REFILL_PER_SEC=100000 \
//     docker compose -p relay-load -f docker-compose.yml -f docker-compose.loadtest.yml up -d
//   docker run --rm --network relay-load_default -v "$PWD/tests/load:/scripts:ro" grafana/k6 run /scripts/k6-throughput.js
//
// Open model (arrival-rate executor): offered load is held constant even when
// latency degrades, so the ceiling shows up as rising percentiles and
// dropped_iterations instead of the tool politely slowing down.
//
// Afterwards, reconcile: k6 `sends_ok` == MySQL row delta == Mongo body delta.

import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://envoy:3000';
const USERS = Number(__ENV.USERS || 50);
const PEAK = Number(__ENV.PEAK || 600); // peak offered sends/sec

const sendsOk = new Counter('sends_ok');
const sendsRejected = new Counter('sends_429');
const wsMessages = new Counter('ws_messages_received');

export const options = {
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    sends: {
      executor: 'ramping-arrival-rate',
      exec: 'sends',
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { target: Math.min(50, PEAK), duration: '20s' },
        { target: Math.round(PEAK / 4), duration: '30s' },
        { target: Math.round(PEAK / 2), duration: '30s' },
        { target: PEAK, duration: '40s' },
        { target: PEAK, duration: '30s' },
        { target: 0, duration: '10s' },
      ],
    },
    sockets: { executor: 'constant-vus', exec: 'sockets', vus: 60, duration: '2m40s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:send}': ['p(95)<500'],
  },
};

export function setup() {
  // Login every user once and resolve their load conversation, so the send
  // loop below is pure write traffic.
  const accounts = [];
  for (let i = 1; i <= USERS; i++) {
    const login = http.post(
      `${BASE}/api/auth/login`,
      JSON.stringify({ username: `loaduser${i}`, password: 'load' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (login.status !== 200) throw new Error(`login loaduser${i}: ${login.status} — did tests/load/seed.mts run?`);
    const cookie = `relay_token=${login.cookies.relay_token[0].value}`;
    const convs = http.get(`${BASE}/api/conversations`, { headers: { Cookie: cookie } });
    const list = JSON.parse(convs.body);
    accounts.push({ cookie, convId: list[list.length - 1].id });
  }
  return { accounts, runId: Math.random().toString(36).slice(2, 8) };
}

export function sends(data) {
  const acct = data.accounts[Math.floor(Math.random() * data.accounts.length)];
  const res = http.post(
    `${BASE}/api/messages`,
    JSON.stringify({
      conversationId: acct.convId,
      body: `throughput probe ${__VU}-${__ITER}`,
      clientId: `k6t-${data.runId}-${__VU}-${__ITER}`,
    }),
    { headers: { 'Content-Type': 'application/json', Cookie: acct.cookie }, tags: { name: 'send' } },
  );
  if (res.status === 201) sendsOk.add(1);
  if (res.status === 429) sendsRejected.add(1);
  check(res, { 'send fully processed (201)': (r) => r.status === 201 });
}

export function sockets(data) {
  const acct = data.accounts[(__VU - 1) % data.accounts.length];
  ws.connect(
    `${BASE.replace('http', 'ws')}/`,
    { headers: { Cookie: acct.cookie } },
    (socket) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', conversationIds: [acct.convId] })));
      socket.on('message', () => wsMessages.add(1));
      socket.setTimeout(() => socket.close(), 60_000);
    },
  );
}
