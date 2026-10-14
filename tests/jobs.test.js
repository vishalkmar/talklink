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
