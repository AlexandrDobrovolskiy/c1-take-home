import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../src/config.ts';
import { signToken } from '../src/auth/tokens.ts';

// HTTP-level auth enforcement tests, run against the live server in this
// container (docker compose exec api npm test). The audit's P4 finding: the
// auth layer — the flagship fix — had zero automated tests.

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';

function cookie(token: string) {
  return { Cookie: `relay_token=${token}` };
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo' }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return /relay_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1];
}

describe('auth enforcement over HTTP', () => {
  it('rejects requests without a token', async () => {
    const res = await fetch(`${BASE}/api/conversations`);
    assert.equal(res.status, 401);
  });

  it('rejects a garbage token', async () => {
    const res = await fetch(`${BASE}/api/conversations`, { headers: cookie('not.a.token') });
    assert.equal(res.status, 401);
  });

  it('survives malformed percent-encoding (regression: used to kill the process)', async () => {
    const res = await fetch(`${BASE}/api/conversations`, { headers: cookie('%') });
    assert.equal(res.status, 401);
    // and the process must still be alive
    const again = await fetch(`${BASE}/api/auth/me`);
    assert.equal(again.status, 401);
  });

  it('closes a WS upgrade with a malformed cookie instead of crashing', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace('http', 'ws')}/`, {
        headers: { Cookie: 'relay_token=%' },
      });
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    assert.equal(code, 4401);
    const alive = await fetch(`${BASE}/api/auth/me`);
    assert.equal(alive.status, 401, 'server survived the malformed WS upgrade');
  });

  it('rejects a token with a tampered MAC', async () => {
    const good = signToken({ uid: 1, name: 'Alice', username: 'alice', exp: Math.floor(Date.now() / 1000) + 60 });
    const [body, mac] = good.split('.');
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
    const res = await fetch(`${BASE}/api/auth/me`, { headers: cookie(`${body}.${flipped}`) });
    assert.equal(res.status, 401);
  });

  it('rejects a token whose payload was altered after signing', async () => {
    const good = signToken({ uid: 2, name: 'Bob', username: 'bob', exp: Math.floor(Date.now() / 1000) + 60 });
    const mac = good.split('.')[1];
    const forgedBody = Buffer.from(
      JSON.stringify({ uid: 1, name: 'Alice', username: 'alice', exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const res = await fetch(`${BASE}/api/auth/me`, { headers: cookie(`${forgedBody}.${mac}`) });
    assert.equal(res.status, 401);
  });

  it('rejects an expired token', async () => {
    const expired = signToken({ uid: 1, name: 'Alice', username: 'alice', exp: Math.floor(Date.now() / 1000) - 10 });
    const res = await fetch(`${BASE}/api/auth/me`, { headers: cookie(expired) });
    assert.equal(res.status, 401);
  });

  it('rejects a token signed with a different secret', async () => {
    const body = Buffer.from(
      JSON.stringify({ uid: 1, name: 'Alice', username: 'alice', exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const mac = crypto.createHmac('sha256', 'some-other-secret').update(body).digest('base64url');
    const res = await fetch(`${BASE}/api/auth/me`, { headers: cookie(`${body}.${mac}`) });
    assert.equal(res.status, 401);
    assert.notEqual(config.authSecret, 'some-other-secret');
  });

  it('enforces conversation membership (403, not 404/200)', async () => {
    const bob = await login('bob'); // bob is not in conversation 2 (Design sync)
    const read = await fetch(`${BASE}/api/messages?conversationId=2`, { headers: cookie(bob) });
    assert.equal(read.status, 403);
    const send = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(bob) },
      body: JSON.stringify({ conversationId: 2, body: 'intrusion', clientId: `auth-test-${Date.now()}` }),
    });
    assert.equal(send.status, 403);
  });
});
