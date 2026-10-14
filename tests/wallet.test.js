// Phase 27: credits wallet - credit / debit, idempotency, concurrency, limits, APIs, admin.
process.env.ADMIN_API_KEY = 'test-admin-key-wallet-0123456789'; // this file only (own process)
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { CreditTransaction, User } = require('../src/models');
const { redis } = require('../src/config/redis');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const wallet = require('../src/services/wallet.service');
const { istDayKey, istDayStart } = require('../src/utils/istDay');
const EVENTS = require('../src/constants/socketEvents.json');

const ADMIN_KEY = process.env.ADMIN_API_KEY;

let server;
let url;
let me;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${me.token}`);

before(async () => {
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  wallet.settings.abuseLimit = 15;
  const user = await createUniqueUser({ email: 'w@t.io', name: 'Wallet', gender: 'female' });
  me = { user, uid: String(user._id), token: signAccessToken(user._id) };
});

afterEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await sleep(40);
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('credit / debit (27.2 - 27.5, 27.17)', () => {
  it('ledger and balance always match; refIds make it idempotent', async () => {
    const a = await wallet.credit({
      userId: me.uid,
      amount: 500,
      type: 'ad_reward',
      refId: 'ad-1',
    });
    const again = await wallet.credit({
      userId: me.uid,
      amount: 500,
      type: 'ad_reward',
      refId: 'ad-1',
    });
    assert.deepEqual([a.applied, a.balance], [true, 500]);
    assert.deepEqual([again.applied, again.balance], [false, 500]);
    const d = await wallet.debit({
      userId: me.uid,
      amount: 200,
      type: 'gender_filter',
      refId: 'f-1',
    });
    assert.equal(d.balance, 300);
    const txs = await CreditTransaction.find({ userId: me.uid }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(
      txs.map((t) => [t.amount, t.balanceAfter]),
      [
        [500, 500],
        [-200, 300],
      ],
    );
    assert.equal((await User.findById(me.uid).lean()).credits, 300);
  });

  it('never goes below zero', async () => {
    await wallet.credit({ userId: me.uid, amount: 100, type: 'admin', refId: 'g' });
    await assert.rejects(
      wallet.debit({ userId: me.uid, amount: 101, type: 'gender_filter', refId: 'x' }),
      (err) => err.code === 'INSUFFICIENT_CREDITS' && err.status === 402,
    );
    assert.equal((await User.findById(me.uid).lean()).credits, 100);
    assert.equal(await CreditTransaction.countDocuments({ refId: 'x' }), 0);
  });

  it('two debits at once cannot overspend (27.17)', async () => {
    await wallet.credit({ userId: me.uid, amount: 10000, type: 'admin', refId: 'g' });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) =>
        wallet.debit({ userId: me.uid, amount: 10000, type: 'gender_filter', refId: `d-${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1);
    results
      .filter((r) => r.status === 'rejected')
      .forEach((r) => assert.equal(r.reason.code, 'INSUFFICIENT_CREDITS'));
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });

  it('the same refId twice at once is applied once', async () => {
    const res = await Promise.all(
      [1, 2, 3].map(() =>
        wallet.credit({ userId: me.uid, amount: 50, type: 'spin', refId: 'same' }),
      ),
    );
    assert.equal(res.filter((r) => r.applied).length, 1);
    assert.equal((await User.findById(me.uid).lean()).credits, 50);
  });

  it('rejects bad amounts', async () => {
    await assert.rejects(wallet.credit({ userId: me.uid, amount: 0, type: 'admin', refId: 'z' }));
    await assert.rejects(wallet.credit({ userId: me.uid, amount: 1.5, type: 'admin', refId: 'z' }));
    await assert.rejects(wallet.debit({ userId: me.uid, amount: -5, type: 'admin', refId: 'z' }));
  });
});

describe('live updates and abuse (27.12 / 27.16)', () => {
  it('wallet:updated reaches my devices', async () => {
    const s = await new Promise((resolve, reject) => {
      const c = ioClient(url, {
        auth: { token: me.token },
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(c);
      c.received = [];
      c.onAny((event, payload) => c.received.push({ event, payload }));
      c.on('connect', () => resolve(c));
      c.on('connect_error', reject);
    });
    await sleep(40);
    await wallet.credit({ userId: me.uid, amount: 20, type: 'daily_bonus', refId: 'b' });
    await sleep(60);
    const ev = s.received.filter((r) => r.event === EVENTS.WALLET_UPDATED).map((r) => r.payload);
    assert.deepEqual(ev, [{ balance: 20, change: 20, type: 'daily_bonus' }]);
  });

  it('a burst of rewards flags the account', async () => {
    wallet.settings.abuseLimit = 3;
    for (let i = 0; i < 5; i += 1) {
      await wallet.credit({ userId: me.uid, amount: 10, type: 'ad_reward', refId: `a${i}` });
    }
    await sleep(80);
    const u = await User.findById(me.uid).lean();
    assert.ok(u.flaggedAt);
    assert.match(u.flagReason, /reward burst/);
  });
});

describe('wallet APIs (27.6, 27.7, 27.14)', () => {
  it('GET /wallet shows balance and today limits', async () => {
    await wallet.credit({ userId: me.uid, amount: 500, type: 'ad_reward', refId: 'ad-1' });
    // rewarded ads are counted by ads.service (Phase 28)
    await redis.set(`ad:count:${me.uid}:${istDayKey()}`, 1);
    await wallet.credit({ userId: me.uid, amount: 50, type: 'spin', refId: 'sp-1' });
    // yesterday's ad does not count today
    await CreditTransaction.collection.updateOne(
      { refId: 'sp-1' },
      { $set: { createdAt: new Date(istDayStart().getTime() - 1000) } },
    );
    const res = await api('get', '/wallet');
    assert.equal(res.status, 200);
    const w = res.body.data;
    assert.equal(w.balance, 550);
    assert.equal(w.genderFilterCost, 10000);
    assert.deepEqual(w.ads, { today: 1, limit: 20, left: 19, reward: 500 });
    assert.equal(w.spins.today, 0);
    assert.equal(w.dailyBonus.claimed, false);
    assert.ok(new Date(w.resetsAt) > new Date());
  });

  it('daily bonus once per IST day', async () => {
    const first = await api('post', '/wallet/daily-bonus');
    assert.deepEqual(first.body.data, { applied: true, amount: 20, balance: 20 });
    const second = await api('post', '/wallet/daily-bonus');
    assert.equal(second.body.data.applied, false);
    assert.equal((await api('get', '/wallet')).body.data.dailyBonus.claimed, true);
    assert.ok(await CreditTransaction.exists({ refId: `daily_bonus:${me.uid}:${istDayKey()}` }));
  });

  it('transactions: newest first with a cursor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await wallet.credit({ userId: me.uid, amount: 10 + i, type: 'spin', refId: `s${i}` });
    }
    const p1 = await api('get', '/wallet/transactions?limit=3');
    assert.deepEqual(
      p1.body.data.items.map((t) => t.amount),
      [14, 13, 12],
    );
    const p2 = await api('get', `/wallet/transactions?limit=3&cursor=${p1.body.data.nextCursor}`);
    assert.deepEqual(
      p2.body.data.items.map((t) => t.amount),
      [11, 10],
    );
    assert.equal(p2.body.data.nextCursor, null);
    assert.equal((await api('get', '/wallet/transactions?cursor=nope')).status, 400);
  });

  it('/config exposes the economy (27.9)', async () => {
    const res = await request(app).get('/api/v1/config');
    assert.equal(res.body.data.credits.genderFilterCost, 10000);
    assert.equal(res.body.data.credits.dailyBonusCredits, 20);
  });
});

describe('admin (27.15)', () => {
  it('grants and takes back credits with an audit reason; retry-safe with refId', async () => {
    const grant = (body) =>
      request(app)
        .post(`/api/v1/admin/users/${me.uid}/credits`)
        .set('X-Admin-Key', ADMIN_KEY)
        .send(body);
    const res = await grant({ amount: 1000, reason: 'support ticket 42', refId: 't42' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      { applied: res.body.data.applied, balance: res.body.data.balance },
      { applied: true, balance: 1000 },
    );
    assert.equal(
      (await grant({ amount: 1000, reason: 'support ticket 42', refId: 't42' })).body.data.applied,
      false,
    );
    assert.equal((await grant({ amount: -300, reason: 'mistake fix' })).body.data.balance, 700);
    assert.equal((await grant({ amount: 0, reason: 'zero' })).status, 400);
    const tx = await CreditTransaction.findOne({ refId: 'admin:t42' }).lean();
    assert.equal(tx.type, 'admin');
    assert.equal(tx.meta.reason, 'support ticket 42');
    assert.equal(
      (
        await request(app)
          .post(`/api/v1/admin/users/${me.uid}/credits`)
          .send({ amount: 5, reason: 'nokey' })
      ).status,
      401,
    );
  });
});
