// Phase 15: matchmaking engine - broadcast waves, first accept wins (socket integration).
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { redis } = require('../src/config/redis');
const { Block, Call } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const match = require('../src/services/match.service');
const filterService = require('../src/services/filter.service');
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

const waitFor = (s, event, ms = 2500) =>
  new Promise((resolve, reject) => {
    const already = got(s, event);
    if (already.length) return resolve(already[already.length - 1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    return s.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

// Creates a user, connects them and (by default) marks them available for random calls.
const person = async (email, { gender = 'female', available = true, autoAccept = false } = {}) => {
  const user = await createUniqueUser({ email, name: `User ${email.split('@')[0]}`, gender });
  const s = await connect(signAccessToken(user._id));
  await sleep(40);
  await ack(s, EVENTS.PRESENCE_SET, { available, foreground: true, autoAccept });
  return { user, uid: String(user._id), s };
};

before(async () => {
  Object.assign(match.settings, { waveIntervalMs: 200, timeoutMs: 900, waveSize: 20 });
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  match.settings.waveSize = 20;
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

describe('match:request', () => {
  it('validates mode / connectWith', async () => {
    const c = await person('c@t.io');
    const res = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'video' });
    assert.equal(res.code, 'VALIDATION_ERROR');
  });

  it('locks the gender filter until it is unlocked (15.3)', async () => {
    const c = await person('c@t.io');
    const locked = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    assert.equal(locked.code, 'FILTER_LOCKED');
    await redis.set(filterService.unlockKey(c.uid), '1', 'EX', 60);
    const ok = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    assert.equal(ok.ok, true);
  });

  it('allows only one pending request per user (15.16)', async () => {
    const c = await person('c@t.io');
    const first = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    const second = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    assert.equal(first.ok, true);
    assert.equal(second.code, 'ALREADY_SEARCHING');
    assert.equal(second.details.requestId, first.requestId); // the app can resume / cancel it
    assert.equal((await presence.getPresence(c.uid)).state, presence.STATE.SEARCHING);
  });
});

describe('broadcast + first accept wins', () => {
  it('offers to available users, connects the first to accept, cancels the rest', async () => {
    const c = await person('caller@t.io', { gender: 'male' });
    const a = await person('a@t.io');
    const b = await person('b@t.io');
    const d = await person('d@t.io');

    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    assert.equal(req.ok, true);
    const offers = await Promise.all([a, b, d].map((p) => waitFor(p.s, EVENTS.MATCH_INCOMING)));
    offers.forEach((o) => {
      assert.equal(o.requestId, req.requestId);
      assert.equal(o.mode, 'audio');
      assert.deepEqual(Object.keys(o.caller).sort(), ['avatar', 'gender', 'id', 'name']);
      assert.equal(o.caller.id, c.uid);
    });
    assert.equal(got(c.s, EVENTS.MATCH_INCOMING).length, 0, 'never offered to yourself');

    const accepted = await ack(a.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.peer.id, c.uid);

    const found = await waitFor(c.s, EVENTS.MATCH_FOUND);
    assert.equal(found.peer.id, a.uid);
    assert.equal(found.roomId, accepted.roomId);
    assert.equal(found.role, 'caller');

    const [cb, cd] = await Promise.all([
      waitFor(b.s, EVENTS.MATCH_CANCELLED),
      waitFor(d.s, EVENTS.MATCH_CANCELLED),
    ]);
    assert.equal(cb.reason, 'taken');
    assert.equal(cd.requestId, req.requestId);

    const call = await Call.findById(accepted.roomId).lean();
    assert.equal(String(call.callerId), c.uid);
    assert.equal(String(call.calleeId), a.uid);
    assert.equal(call.status, 'ringing');
    assert.equal(call.matchType, 'random');
    assert.equal((await presence.getPresence(c.uid)).state, presence.STATE.IN_CALL);
    assert.equal((await presence.getPresence(a.uid)).state, presence.STATE.IN_CALL);
    // Phase 17: the audio call is registered for signaling
    assert.equal(await redis.get(`user:${c.uid}:call`), accepted.roomId);
    assert.equal(await redis.get(`user:${a.uid}:call`), accepted.roomId);

    // late accept by someone else
    const late = await ack(b.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId });
    assert.equal(late.ok, false);
  });

  it('5 simultaneous accepts -> exactly one winner (15.19)', async () => {
    const c = await person('caller@t.io');
    const cands = await Promise.all([1, 2, 3, 4, 5].map((i) => person(`p${i}@t.io`)));
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await Promise.all(cands.map((p) => waitFor(p.s, EVENTS.MATCH_INCOMING)));

    const results = await Promise.all(
      cands.map((p) => ack(p.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId })),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1);
    results
      .filter((r) => !r.ok)
      .forEach((r) => assert.ok(['TAKEN', 'NOT_AVAILABLE'].includes(r.code), r.code));
    assert.equal(await Call.countDocuments({ callerId: c.uid }), 1);
  });

  it('text matches create an active session straight away', async () => {
    const c = await person('caller@t.io');
    const a = await person('a@t.io');
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'text' });
    await waitFor(a.s, EVENTS.MATCH_INCOMING);
    const res = await ack(a.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId });
    const call = await Call.findById(res.roomId).lean();
    assert.equal(call.mode, 'text');
    assert.equal(call.status, 'active');
    assert.equal((await presence.getPresence(a.uid)).state, presence.STATE.IN_CHAT);
  });
});

describe('who gets offered (15.5)', () => {
  it('skips blocked (both ways), unavailable, filtered-out and recently matched users', async () => {
    const c = await person('caller@t.io', { gender: 'male' });
    const blockedByCaller = await person('x@t.io');
    const blockedCaller = await person('y@t.io');
    const ok = await person('z@t.io');
    const off = await person('w@t.io', { available: false });
    const recent = await person('r@t.io');
    await Block.create({ blockerId: c.uid, blockedId: blockedByCaller.uid });
    await Block.create({ blockerId: blockedCaller.uid, blockedId: c.uid });
    await redis.zadd(match.keys.recent(c.uid), Date.now(), recent.uid);

    await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await waitFor(ok.s, EVENTS.MATCH_INCOMING);
    await sleep(300); // a second wave too
    for (const p of [blockedByCaller, blockedCaller, off, recent]) {
      assert.equal(got(p.s, EVENTS.MATCH_INCOMING).length, 0);
    }
  });

  it('uses the gender pool when the filter is on', async () => {
    const c = await person('caller@t.io', { gender: 'male' });
    const f = await person('f@t.io', { gender: 'female' });
    const m = await person('m@t.io', { gender: 'male' });
    await redis.set(filterService.unlockKey(c.uid), '1', 'EX', 60);
    await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio', connectWith: 'female' });
    await waitFor(f.s, EVENTS.MATCH_INCOMING);
    await sleep(300);
    assert.equal(got(m.s, EVENTS.MATCH_INCOMING).length, 0);
  });

  it('sends waves of waveSize until timeout (15.6)', async () => {
    match.settings.waveSize = 2;
    const c = await person('caller@t.io');
    const cands = await Promise.all([1, 2, 3, 4, 5].map((i) => person(`w${i}@t.io`)));
    await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await sleep(80);
    const afterFirst = cands.filter((p) => got(p.s, EVENTS.MATCH_INCOMING).length).length;
    assert.equal(afterFirst, 2);
    await sleep(500);
    const later = cands.filter((p) => got(p.s, EVENTS.MATCH_INCOMING).length).length;
    assert.equal(later, 5);
    cands.forEach((p) =>
      assert.ok(got(p.s, EVENTS.MATCH_INCOMING).length <= 1, 'never offered twice'),
    );
  });

  it('shows one offer at a time per candidate', async () => {
    const c1 = await person('c1@t.io');
    const c2 = await person('c2@t.io');
    const cand = await person('cand@t.io');
    // c1 and c2 are available too, so they could be offered each other - exclude via recent
    await redis.zadd(match.keys.recent(c1.uid), Date.now(), c2.uid);
    await redis.zadd(match.keys.recent(c2.uid), Date.now(), c1.uid);
    await ack(c1.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await waitFor(cand.s, EVENTS.MATCH_INCOMING);
    await ack(c2.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await sleep(300);
    assert.equal(got(cand.s, EVENTS.MATCH_INCOMING).length, 1);
  });
});

describe('decline, timeout, cancel', () => {
  it('a declined request is not offered again', async () => {
    const c = await person('caller@t.io');
    const a = await person('a@t.io');
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await waitFor(a.s, EVENTS.MATCH_INCOMING);
    assert.deepEqual(await ack(a.s, EVENTS.MATCH_DECLINE, { requestId: req.requestId }), {
      ok: true,
      declined: true,
    });
    await sleep(500);
    assert.equal(got(a.s, EVENTS.MATCH_INCOMING).length, 1);
  });

  it('nobody accepts -> match:timeout to the caller, popups close, caller can retry', async () => {
    const c = await person('caller@t.io');
    const a = await person('a@t.io');
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    const timeout = await waitFor(c.s, EVENTS.MATCH_TIMEOUT, 2500);
    assert.equal(timeout.requestId, req.requestId);
    const cancelled = await waitFor(a.s, EVENTS.MATCH_CANCELLED);
    assert.equal(cancelled.reason, 'timeout');
    assert.equal((await presence.getPresence(c.uid)).state, presence.STATE.AVAILABLE);
    assert.equal((await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' })).ok, true);
  });

  it('the caller can cancel; others cannot', async () => {
    const c = await person('caller@t.io');
    const a = await person('a@t.io');
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await waitFor(a.s, EVENTS.MATCH_INCOMING);
    assert.equal(
      (await ack(a.s, EVENTS.MATCH_CANCEL, { requestId: req.requestId })).code,
      'FORBIDDEN',
    );
    assert.deepEqual(await ack(c.s, EVENTS.MATCH_CANCEL, { requestId: req.requestId }), {
      ok: true,
      cancelled: true,
    });
    assert.equal((await waitFor(a.s, EVENTS.MATCH_CANCELLED)).reason, 'cancelled');
    assert.equal((await ack(a.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId })).ok, false);
  });

  it('caller disconnecting cancels the request', async () => {
    const c = await person('caller@t.io');
    const a = await person('a@t.io');
    await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    await waitFor(a.s, EVENTS.MATCH_INCOMING);
    c.s.disconnect();
    assert.equal((await waitFor(a.s, EVENTS.MATCH_CANCELLED)).reason, 'cancelled');
  });

  it('only invited users can accept', async () => {
    const c = await person('caller@t.io');
    const outsider = await person('o@t.io', { available: false });
    const req = await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    const res = await ack(outsider.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId });
    assert.equal(res.code, 'NOT_INVITED');
  });
});

describe('auto-accept (15.17)', () => {
  it('connects users who opted into auto-accept without a tap', async () => {
    const c = await person('caller@t.io');
    const auto = await person('auto@t.io', { autoAccept: true });
    await ack(c.s, EVENTS.MATCH_REQUEST, { mode: 'audio' });
    const found = await waitFor(c.s, EVENTS.MATCH_FOUND);
    assert.equal(found.peer.id, auto.uid);
    assert.equal((await waitFor(auto.s, EVENTS.MATCH_FOUND)).role, 'callee');
  });
});
