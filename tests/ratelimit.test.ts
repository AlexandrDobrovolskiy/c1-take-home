import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeRedis, connectRedis, redisPub } from '../src/db/redis.ts';
import { consume } from '../src/lib/rateLimit.ts';

// Integration tests against the compose Redis (docker compose exec api npm test).

const KEY = () => `test-rl:${Math.random().toString(36).slice(2)}`;

before(async () => {
  await connectRedis();
});

after(async () => {
  const keys = await redisPub.keys('rl:test-rl:*');
  if (keys.length) await redisPub.del(keys);
  await closeRedis();
});

describe('token bucket rate limiter', () => {
  it('allows a burst up to capacity, then denies with a positive retry-after', async () => {
    const key = KEY();
    const opts = { capacity: 3, refillPerSec: 1 };
    for (let i = 0; i < 3; i++) {
      const r = await consume(key, opts);
      assert.equal(r.allowed, true, `request ${i + 1} within capacity must pass`);
    }
    const denied = await consume(key, opts);
    assert.equal(denied.allowed, false, 'request over capacity must be denied');
    assert.ok(denied.retryAfterS > 0, 'denial must say how long to back off');
    assert.ok(denied.retryAfterS <= 1.1, 'one token refills in ~1s at 1 token/s');
  });

  it('refills over time', async () => {
    const key = KEY();
    const opts = { capacity: 2, refillPerSec: 2 }; // one token every 500ms
    await consume(key, opts);
    await consume(key, opts);
    assert.equal((await consume(key, opts)).allowed, false, 'bucket drained');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await consume(key, opts)).allowed, true, 'a token refilled after ~500ms');
    assert.equal((await consume(key, opts)).allowed, false, 'only one token refilled');
  });

  it('keys are independent — one noisy key never throttles another', async () => {
    const noisy = KEY();
    const quiet = KEY();
    const opts = { capacity: 2, refillPerSec: 1 };
    for (let i = 0; i < 5; i++) await consume(noisy, opts);
    assert.equal((await consume(noisy, opts)).allowed, false);
    assert.equal((await consume(quiet, opts)).allowed, true);
  });

  it('never exceeds capacity under concurrent requests (atomicity)', async () => {
    const key = KEY();
    const opts = { capacity: 5, refillPerSec: 0.5 };
    const results = await Promise.all(Array.from({ length: 20 }, () => consume(key, opts)));
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, 5, `exactly capacity allowed under a 20-wide concurrent burst, got ${allowed}`);
  });
});
