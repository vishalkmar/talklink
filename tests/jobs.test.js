// Phase 34.8: with several server processes a scheduled job runs once per slot.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { runSafely, takeLock } = require('../src/jobs');

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

describe('job lock', () => {
  it('only one of many instances runs the job; the next minute runs again', async () => {
    let runs = 0;
    const job = runSafely('test-job', async () => {
      runs += 1;
    });
    // five "instances" fire at the same time
    await Promise.all([job(), job(), job(), job(), job()]);
    assert.equal(runs, 1);
    const now = Date.now();
    assert.equal(await takeLock('other-job', now), true);
    assert.equal(await takeLock('other-job', now), false);
    assert.equal(await takeLock('other-job', now + 60000), true); // next slot
  });

  it('a failing job is logged, not thrown', async () => {
    const job = runSafely('broken-job', async () => {
      throw new Error('boom');
    });
    await assert.doesNotReject(job());
  });
});

describe('keep-alive (Render free plan)', () => {
  it('pings <url>/health/ping and fails loudly on a bad answer', async () => {
    const { keepAlive } = require('../src/jobs');
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 503 };
    };
    try {
      await keepAlive('https://talklink-api.onrender.com');
      assert.deepEqual(calls, ['https://talklink-api.onrender.com/health/ping']);
      await assert.rejects(keepAlive('https://x.onrender.com'), /503/);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('/health/ping answers pong without auth', async () => {
    const request = require('supertest');
    const app = require('../src/app');
    const res = await request(app).get('/health/ping');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'pong');
  });
});
