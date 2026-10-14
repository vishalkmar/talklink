// Phase 30: gender-filter unlock (time pass), matching check, refund, premium, emulator block.
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
const match = require('../src/services/match.service');
const filters = require('../src/services/filter.service');
const wallet = require('../src/services/wallet.service');
const ads = require('../src/services/ads.service');
const EVENTS = require('../src/constants/socketEvents.json');

let server;
let url;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(s);
    s.received = [];
    s.onAny((event, payload) => s.received.push({ event, payload }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const ack = (s, event, payload) => s.timeout(3000).emitWithAck(event, payload);
const got = (s, event) => s.received.filter((r) => r.event === event).map((r) => r.payload);
const waitFor = (s, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const have = got(s, event);
    if (have.length) return resolve(have[have.length - 1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    return s.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

const person = async (email, gender, credits = 0) => {
  const user = await createUniqueUser({ email, name: `U ${email[0]}`, gender });
  if (credits)
    await wallet.credit({
      userId: user._id,
      amount: credits,
      type: 'admin',
      refId: `seed:${email}`,
    });
  const token = signAccessToken(user._id);
  const s = await connect(token);
  await sleep(40);
  await ack(s, EVENTS.PRESENCE_SET, { available: true, foreground: true });
  return { user, uid: String(user._id), token, s };
};
const api = (u, method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${u.token}`);

before(async () => {
  Object.assign(match.settings, { waveIntervalMs: 200, timeoutMs: 700, waveSize: 20 });
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  Object.assign(filters.settings, { cost: 10000, passMs: 30 * 60 * 1000 });
});

afterEach(async () => {
  match.__resetForTests();
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('unlock (30.6, 30.7, 30.11)', () => {
  it('spends the cost and opens the chosen filter for the pass time', async () => {
    const me = await person('m@t.io', 'male', 12000);
    const res = await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.gender, 'female');
    assert.equal(res.body.data.balance, 2000);
    const until = new Date(res.body.data.until).getTime();
    assert.ok(Math.abs(until - (Date.now() + 30 * 60000)) < 5000);
    const tx = await CreditTransaction.findOne({ type: 'gender_filter' }).lean();
    assert.equal(tx.amount, -10000);
    const upd = await waitFor(me.s, EVENTS.FILTER_UPDATED);
    assert.equal(upd.active.gender, 'female');

    const st = (await api(me, 'get', '/filters')).body.data;
    assert.equal(st.active.gender, 'female');
    assert.equal(st.cost, 10000);
    assert.equal(st.passMinutes, 30);

    // unlocking the same filter again doesn't charge twice
    const again = await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    assert.equal(again.body.data.alreadyActive, true);
    assert.equal((await User.findById(me.uid).lean()).credits, 2000);
  });

  it('not enough credits -> 402, nothing changes', async () => {
    const me = await person('m@t.io', 'male', 500);
    const res = await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(await redis.exists(filters.unlockKey(me.uid)), 0);
    assert.equal((await api(me, 'post', '/filters/unlock').send({ gender: 'other' })).status, 400);
  });

  it('premium users get it free (30.10)', async () => {
    const me = await person('m@t.io', 'male', 0);
    await User.updateOne(
      { _id: me.uid },
      { isPremium: true, premiumUntil: new Date(Date.now() + 86400000) },
    );
    const res = await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    assert.deepEqual(res.body.data, { gender: 'female', premium: true, until: null });
    const ok = await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    assert.equal(ok.ok, true);
  });

  it('expires after the pass time', async () => {
    filters.settings.passMs = 150;
    const me = await person('m@t.io', 'male', 10000);
    await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    await sleep(250);
    assert.equal((await api(me, 'get', '/filters')).body.data.active, null);
    const locked = await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    assert.equal(locked.code, 'FILTER_LOCKED');
  });
});

describe('matching uses the pass (30.8) and refunds (30.9)', () => {
  it('only the unlocked gender is allowed', async () => {
    const me = await person('m@t.io', 'male', 10000);
    await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    const wrong = await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'male' });
    assert.equal(wrong.code, 'FILTER_LOCKED');
    const ok = await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    assert.equal(ok.ok, true);
  });

  it('no match found -> credits back automatically and the pass closes', async () => {
    const me = await person('m@t.io', 'male', 10000);
    await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    const timeout = await waitFor(me.s, EVENTS.MATCH_TIMEOUT, 3000);
    assert.equal(timeout.refunded, true);
    assert.equal((await User.findById(me.uid).lean()).credits, 10000);
    const refund = await CreditTransaction.findOne({ type: 'refund' }).lean();
    assert.equal(refund.amount, 10000);
    assert.equal(refund.meta.reason, 'no_match');
    assert.equal(await redis.exists(filters.unlockKey(me.uid)), 0);
    const upd = got(me.s, EVENTS.FILTER_UPDATED).pop();
    assert.deepEqual(upd, { active: null, refunded: true, credits: 10000 });
  });

  it('after one filtered match there is no refund any more', async () => {
    const me = await person('m@t.io', 'male', 10000);
    const her = await person('f@t.io', 'female');
    await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    const req = await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    await waitFor(her.s, EVENTS.MATCH_INCOMING);
    assert.equal((await ack(her.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId })).ok, true);
    assert.equal(await filters.refundIfUnused(me.uid), false);
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });

  it('a search without the filter never refunds', async () => {
    const me = await person('m@t.io', 'male', 10000);
    await api(me, 'post', '/filters/unlock').send({ gender: 'female' });
    await ack(me.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'anyone' });
    const timeout = await waitFor(me.s, EVENTS.MATCH_TIMEOUT, 3000);
    assert.equal(timeout.refunded, false);
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });
});

describe('anti-fraud (30.16)', () => {
  it('no ad rewards on an emulator when REWARDS_BLOCK_EMULATORS is on', async () => {
    const me = await person('m@t.io', 'male');
    ads.settings.blockEmulators = true;
    const res = await api(me, 'post', '/ads/nonce').send({
      purpose: 'credits',
      device: { emulator: true },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'REWARDS_UNAVAILABLE');
    const phone = await api(me, 'post', '/ads/nonce').send({
      purpose: 'credits',
      device: { emulator: false },
    });
    assert.equal(phone.status, 200);
    ads.settings.blockEmulators = false;
    const dev = await api(me, 'post', '/ads/nonce').send({
      purpose: 'credits',
      device: { emulator: true },
    });
    assert.equal(dev.status, 200);
  });
});
