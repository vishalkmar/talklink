// Phase 29: spin wheel - weighted results, free spin, ad tokens, daily limit, races.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { CreditTransaction, User } = require('../src/models');
const { store } = require('../src/config/store');
const spin = require('../src/services/spin.service');
const ads = require('../src/services/ads.service');

let me;
const api = (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${me.token}`);
const giveAdSpins = (n) => store.set(spin.keys.extra(me.uid), n);

before(connectTestDeps);

beforeEach(async () => {
  Object.assign(spin.settings, {
    perDay: 5,
    freePerDay: 1,
    random: (max) => crypto.randomInt(max),
  });
  const user = await createUniqueUser({ email: 's@t.io', name: 'Spinner', gender: 'female' });
  me = { user, uid: String(user._id), token: signAccessToken(user._id) };
});

afterEach(resetTestDeps);
after(closeTestDeps);

describe('weighted results (29.3, 29.17)', () => {
  it('follows the weights over many spins', () => {
    const counts = new Array(spin.settings.segments.length).fill(0);
    const N = 100000;
    for (let i = 0; i < N; i += 1) counts[spin.pickSegment()] += 1;
    const total = spin.settings.segments.reduce((n, s) => n + s.weight, 0);
    spin.settings.segments.forEach((s, i) => {
      const expected = s.weight / total;
      assert.ok(
        Math.abs(counts[i] / N - expected) < 0.01,
        `segment ${i}: ${counts[i] / N} vs ${expected}`,
      );
    });
  });

  it('maps the random number to the right segment at the edges', () => {
    const total = spin.settings.segments.reduce((n, s) => n + s.weight, 0);
    spin.settings.random = () => 0;
    assert.equal(spin.pickSegment(), 0);
    spin.settings.random = () => total - 1;
    assert.equal(spin.pickSegment(), spin.settings.segments.length - 1);
    spin.settings.random = () => spin.settings.segments[0].weight; // first value of segment 1
    assert.equal(spin.pickSegment(), 1);
  });
});

describe('POST /spin (29.4, 29.5, 29.9, 29.10, 29.13)', () => {
  it('first spin of the day is free and credits the wallet with segment info', async () => {
    spin.settings.random = () => 0; // segment 0 = 10 credits
    const res = await api('post', '/spin');
    assert.equal(res.status, 200);
    assert.deepEqual(
      { i: res.body.data.segmentIndex, c: res.body.data.credits, f: res.body.data.free },
      { i: 0, c: 10, f: true },
    );
    assert.equal(res.body.data.balance, 10);
    assert.equal(res.body.data.left, 4);
    const tx = await CreditTransaction.findOne({ type: 'spin' }).lean();
    assert.deepEqual(tx.meta, { segmentIndex: 0, credits: 10, free: true });
    assert.equal((await User.findById(me.uid).lean()).credits, 10);
  });

  it('later spins need a video token; without one nothing is used up (29.12)', async () => {
    await api('post', '/spin');
    const need = await api('post', '/spin');
    assert.equal(need.status, 402);
    assert.equal(need.body.code, 'AD_REQUIRED');
    assert.equal((await api('get', '/spin')).body.data.today, 1); // not consumed

    await giveAdSpins(1);
    const paid = await api('post', '/spin');
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.free, false);
    assert.equal(paid.body.data.adSpins, 0);
  });

  it('a rewarded ad with purpose spin gives the token (Phase 28 link)', async () => {
    ads.settings.ssvEnabled = false;
    await api('post', '/spin');
    const { nonce } = (await api('post', '/ads/nonce').send({ purpose: 'spin' })).body.data;
    await api('post', '/ads/claim').send({ nonce });
    assert.equal((await api('get', '/spin')).body.data.adSpins, 1);
    assert.equal((await api('post', '/spin')).status, 200);
    ads.settings.ssvEnabled = true;
  });

  it('stops at SPINS_PER_DAY with the reset time', async () => {
    spin.settings.perDay = 2;
    await giveAdSpins(5);
    assert.equal((await api('post', '/spin')).status, 200);
    assert.equal((await api('post', '/spin')).status, 200);
    const limited = await api('post', '/spin');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'SPIN_LIMIT');
    assert.ok(new Date(limited.body.details.resetsAt) > new Date());
    const st = (await api('get', '/spin')).body.data;
    assert.equal(st.left, 0);
    assert.equal(st.adSpins, 0);
  });

  it('parallel taps can never exceed the limit or double-use a token', async () => {
    spin.settings.perDay = 3;
    await giveAdSpins(1);
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => api('post', '/spin')));
    const ok = res.filter((r) => r.status === 200);
    assert.equal(ok.length, 2); // 1 free + 1 token
    assert.equal(await CreditTransaction.countDocuments({ type: 'spin' }), 2);
    assert.equal(Number(await store.get(spin.keys.count(me.uid))), 2);
  });
});

describe('GET /spin (29.9, 29.14)', () => {
  it('status with segments, counters and recent history', async () => {
    spin.settings.random = () => 0;
    await api('post', '/spin');
    const st = (await api('get', '/spin')).body.data;
    assert.deepEqual(st.segments, [10, 20, 50, 100, 25, 200, 15, 500]);
    assert.equal(st.perDay, 5);
    assert.equal(st.today, 1);
    assert.equal(st.left, 4);
    assert.equal(st.freeLeft, 0);
    assert.equal(st.history.length, 1);
    assert.deepEqual(
      { c: st.history[0].credits, i: st.history[0].segmentIndex, f: st.history[0].free },
      { c: 10, i: 0, f: true },
    );
    assert.equal((await api('get', '/wallet')).body.data.spins.today, 1);
    // weights stay on the server
    const cfg = await request(app).get('/api/v1/config');
    assert.deepEqual(cfg.body.data.spin.segments, st.segments);
    assert.equal(cfg.body.data.spin.freePerDay, 1);
  });
});
