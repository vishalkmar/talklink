// Phase 14: presence & availability (unit + socket integration).
process.env.ADMIN_API_KEY = 'test-admin-key-test-admin-key-000'; // this file only (own process)

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { redis } = require('../src/config/redis');
const { User } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const EVENTS = require('../src/constants/socketEvents.json');

const { STATE, keys: K } = presence;
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
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const makeUser = async (email, fields = {}) => {
  const user = await createUniqueUser({ email, name: 'Riya', gender: 'female', ...fields });
  return { user, uid: String(user._id), token: signAccessToken(user._id) };
};

const setState = (s, payload) => s.timeout(2000).emitWithAck(EVENTS.PRESENCE_SET, payload);
const inPool = async (key, uid) => (await redis.zscore(key, uid)) !== null;

before(async () => {
  presence.settings.offlineGraceMs = 150;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await sleep(50);
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('eligibility rules', () => {
  // IST = UTC + 5:30
  const ist = (hh, mm) => new Date(Date.UTC(2026, 9, 7, hh, mm) - 330 * 60000);

  it('Do Not Disturb windows, including ones across midnight', () => {
    const night = { enabled: true, start: '22:00', end: '07:00' };
    assert.equal(presence.isWithinDnd(night, ist(23, 30)), true);
    assert.equal(presence.isWithinDnd(night, ist(6, 59)), true);
    assert.equal(presence.isWithinDnd(night, ist(7, 0)), false);
    assert.equal(presence.isWithinDnd(night, ist(12, 0)), false);
    const lunch = { enabled: true, start: '13:00', end: '15:00' };
    assert.equal(presence.isWithinDnd(lunch, ist(14, 0)), true);
    assert.equal(presence.isWithinDnd(lunch, ist(15, 0)), false);
    assert.equal(presence.isWithinDnd({ ...night, enabled: false }, ist(23, 30)), false);
  });

  it('invisible, paused or suspended users are never eligible', () => {
    const base = { status: 'active', settings: { dnd: { enabled: false } } };
    assert.equal(presence.isEligibleForRandom(base), true);
    assert.equal(presence.isEligibleForRandom({ ...base, settings: { invisible: true } }), false);
    assert.equal(
      presence.isEligibleForRandom({ ...base, matchingPausedUntil: new Date(Date.now() + 60000) }),
      false,
    );
    assert.equal(presence.isEligibleForRandom({ ...base, status: 'suspended' }), false);
  });
});

describe('presence transitions (socket)', () => {
  it('idle on connect -> available -> background -> busy -> back to available -> toggle off', async () => {
    const { uid, token } = await makeUser('p1@t.io');
    const s = await connect(token);
    await sleep(80);
    assert.equal((await presence.getPresence(uid)).state, STATE.ONLINE_IDLE);
    assert.equal(await presence.onlineCount(), 1);

    assert.deepEqual(await setState(s, { available: true, foreground: true }), {
      ok: true,
      state: STATE.AVAILABLE,
    });
    assert.equal(await inPool(K.available, uid), true);
    assert.equal(await inPool(K.availableGender('female'), uid), true);
    assert.equal(await inPool(K.availableGender('male'), uid), false);

    assert.equal(
      (await setState(s, { available: true, foreground: false })).state,
      STATE.ONLINE_IDLE,
    );
    assert.equal(await inPool(K.available, uid), false);

    await setState(s, { available: true, foreground: true });
    await presence.setBusy(uid, STATE.IN_CALL);
    assert.equal((await presence.getPresence(uid)).state, STATE.IN_CALL);
    assert.equal(await inPool(K.available, uid), false);
    // the app reporting foreground again must not override a busy state
    assert.equal((await setState(s, { available: true, foreground: true })).state, STATE.IN_CALL);

    assert.equal(await presence.clearBusy(uid), STATE.AVAILABLE);
    assert.equal(await inPool(K.available, uid), true);

    assert.equal(
      (await setState(s, { available: false, foreground: true })).state,
      STATE.ONLINE_IDLE,
    );
    assert.equal(await inPool(K.available, uid), false);
  });

  it('puts men in the male pool and "other" only in the general pool', async () => {
    const m = await makeUser('m@t.io', { gender: 'male' });
    const o = await makeUser('o@t.io', { gender: 'other' });
    const [sm, so] = await Promise.all([connect(m.token), connect(o.token)]);
    await sleep(80);
    await setState(sm, { available: true });
    await setState(so, { available: true });
    assert.equal(await inPool(K.availableGender('male'), m.uid), true);
    assert.equal(await inPool(K.available, o.uid), true);
    assert.equal(await inPool(K.availableGender('male'), o.uid), false);
    assert.equal(await inPool(K.availableGender('female'), o.uid), false);
  });

  it('users in Do Not Disturb hours stay idle', async () => {
    const { uid, token } = await makeUser('dnd@t.io', {
      settings: { dnd: { enabled: true, start: '00:00', end: '23:59' } },
    });
    const s = await connect(token);
    await sleep(80);
    assert.equal((await setState(s, { available: true })).state, STATE.ONLINE_IDLE);
    assert.equal(await inPool(K.available, uid), false);
  });

  it('validates presence:set', async () => {
    const { token } = await makeUser('v@t.io');
    const s = await connect(token);
    const res = await setState(s, { foreground: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'VALIDATION_ERROR');
  });

  it('goes offline after the grace period and saves lastSeen', async () => {
    const { uid, token } = await makeUser('off@t.io');
    const s = await connect(token);
    await sleep(80);
    await setState(s, { available: true });
    s.disconnect();
    await sleep(60);
    assert.notEqual((await presence.getPresence(uid)).state, STATE.OFFLINE, 'still within grace');
    await sleep(250);
    assert.equal((await presence.getPresence(uid)).state, STATE.OFFLINE);
    assert.equal(await inPool(K.available, uid), false);
    assert.equal(await presence.onlineCount(), 0);
    assert.ok((await User.findById(uid)).lastSeenAt);
  });

  it('a quick reconnect inside the grace period keeps the user online', async () => {
    const { uid, token } = await makeUser('rc@t.io');
    const s1 = await connect(token);
    await sleep(60);
    s1.disconnect();
    await sleep(40);
    await connect(token);
    await sleep(300);
    assert.equal((await presence.getPresence(uid)).state, STATE.ONLINE_IDLE);
  });
});

describe('stale cleanup + endpoints', () => {
  it('cleanupStale removes members whose heartbeat stopped', async () => {
    const old = Date.now() - presence.settings.staleMs - 1000;
    await redis.zadd(K.online, old, 'ghost');
    await redis.zadd(K.available, old, 'ghost');
    await redis.zadd(K.online, Date.now(), 'alive');
    assert.equal(await presence.onlineCount(), 1); // stale ones never count
    assert.equal(await presence.cleanupStale(), 2);
    assert.equal(await redis.zscore(K.available, 'ghost'), null);
  });

  it('GET /stats/online counts online users', async () => {
    const a = await makeUser('s1@t.io');
    await connect(a.token);
    await sleep(80);
    const res = await request(app)
      .get('/api/v1/stats/online')
      .set('Authorization', `Bearer ${a.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.online, 1);
  });

  it('GET /admin/presence needs the admin key', async () => {
    assert.equal((await request(app).get('/api/v1/admin/presence')).status, 401);
    const res = await request(app)
      .get('/api/v1/admin/presence')
      .set('X-Admin-Key', process.env.ADMIN_API_KEY);
    assert.equal(res.status, 200);
    assert.ok('availableByGender' in res.body.data);
  });
});
