// Phase 17: WebRTC signaling server (socket integration) + TURN credentials.
process.env.TURN_HOST = 'turn.test.local';
process.env.TURN_SECRET = 'turn-shared-secret-for-tests';
process.env.TURN_TTL = '3600';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { store } = require('../src/config/store');
const { Call, User, Block } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const callSession = require('../src/services/callSession.service');
const blockService = require('../src/services/block.service');
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
    const have = got(s, event);
    if (have.length) return resolve(have[have.length - 1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    return s.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

const makeUser = async (email) => {
  const user = await createUniqueUser({ email, name: `User ${email[0]}`, gender: 'female' });
  return { user, uid: String(user._id), token: signAccessToken(user._id) };
};

// caller + callee connected, in a registered audio call (as after a match)
const setupCall = async () => {
  const caller = await makeUser('caller@t.io');
  const callee = await makeUser('callee@t.io');
  const call = await Call.create({
    callerId: caller.uid,
    calleeId: callee.uid,
    mode: 'audio',
    matchType: 'random',
    status: 'ringing',
  });
  const roomId = String(call._id);
  await callSession.registerCall({
    roomId,
    callerId: caller.uid,
    calleeId: callee.uid,
    mode: 'audio',
  });
  caller.s = await connect(caller.token);
  callee.s = await connect(callee.token);
  await sleep(60);
  await presence.setBusy(caller.uid, presence.STATE.IN_CALL);
  await presence.setBusy(callee.uid, presence.STATE.IN_CALL);
  return { caller, callee, roomId };
};

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n' };
const CAND = {
  candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 51234 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

before(async () => {
  Object.assign(callSession.settings, {
    peerLostGraceMs: 300,
    maxDurationMs: 60 * 60 * 1000,
    auraPerMinute: 1,
  });
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  callSession.__resetForTests();
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  callSession.settings.maxDurationMs = 60 * 60 * 1000;
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('relay (17.3 - 17.6)', () => {
  it('relays offer, answer and ICE between the two participants only', async () => {
    const { caller, callee, roomId } = await setupCall();
    const outsider = await makeUser('out@t.io');
    outsider.s = await connect(outsider.token);

    assert.deepEqual(await ack(caller.s, EVENTS.CALL_OFFER, { roomId, sdp: OFFER }), { ok: true });
    const offer = await waitFor(callee.s, EVENTS.CALL_OFFER);
    assert.deepEqual(offer, { roomId, from: caller.uid, sdp: OFFER });

    await ack(callee.s, EVENTS.CALL_ANSWER, { roomId, sdp: ANSWER });
    assert.deepEqual((await waitFor(caller.s, EVENTS.CALL_ANSWER)).sdp, ANSWER);

    await ack(caller.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    await ack(callee.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    assert.deepEqual((await waitFor(callee.s, EVENTS.CALL_ICE)).candidate, CAND);
    assert.deepEqual((await waitFor(caller.s, EVENTS.CALL_ICE)).candidate, CAND);

    await sleep(80);
    assert.equal(outsider.s.received.filter((r) => r.event.startsWith('call:')).length, 0);
  });

  it('a third user cannot inject ICE or end the call (17.17)', async () => {
    const { callee, roomId } = await setupCall();
    const intruder = await makeUser('x@t.io');
    intruder.s = await connect(intruder.token);
    const res = await ack(intruder.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    assert.equal(res.code, 'NOT_IN_CALL');
    assert.equal((await ack(intruder.s, EVENTS.CALL_END, { roomId })).code, 'NOT_IN_CALL');
    await sleep(80);
    assert.equal(got(callee.s, EVENTS.CALL_ICE).length, 0);
    assert.ok(await callSession.getCall(roomId));
  });

  it('opening the app on a second device during a call does not steal the call', async () => {
    const { caller, callee, roomId } = await setupCall();
    await ack(callee.s, EVENTS.CALL_ANSWER, { roomId, sdp: ANSWER }); // bind callee's call device
    const extra = await connect(callee.token); // e.g. a tablet comes online
    await sleep(80);
    assert.equal(got(caller.s, EVENTS.CALL_PEER_STATUS).length, 0);
    await ack(caller.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    await waitFor(callee.s, EVENTS.CALL_ICE);
    await sleep(60);
    assert.equal(got(extra, EVENTS.CALL_ICE).length, 0);
  });

  it('sends signaling only to the device that is in the call', async () => {
    const { caller, callee, roomId } = await setupCall();
    const calleeOtherDevice = await connect(callee.token);
    await ack(callee.s, EVENTS.CALL_ANSWER, { roomId, sdp: ANSWER }); // binds this device
    await ack(caller.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    await waitFor(callee.s, EVENTS.CALL_ICE);
    await sleep(80);
    assert.equal(got(calleeOtherDevice, EVENTS.CALL_ICE).length, 0);
  });

  it('relays mute state and ICE restarts', async () => {
    const { caller, callee, roomId } = await setupCall();
    await ack(caller.s, EVENTS.CALL_MUTE_STATE, { roomId, muted: true });
    assert.equal((await waitFor(callee.s, EVENTS.CALL_MUTE_STATE)).muted, true);
    await ack(caller.s, EVENTS.CALL_ICE_RESTART, { roomId, sdp: OFFER });
    assert.deepEqual((await waitFor(callee.s, EVENTS.CALL_ICE_RESTART)).sdp, OFFER);
  });

  it('relays hold state (20.16)', async () => {
    const { caller, callee, roomId } = await setupCall();
    assert.equal((await ack(callee.s, EVENTS.CALL_HOLD, { roomId, onHold: true })).ok, true);
    const p = await waitFor(caller.s, EVENTS.CALL_HOLD);
    assert.equal(p.onHold, true);
    assert.equal(p.roomId, roomId);
    assert.equal((await ack(callee.s, EVENTS.CALL_HOLD, { roomId })).code, 'VALIDATION_ERROR');
  });

  it('validates payloads', async () => {
    const { caller, roomId } = await setupCall();
    assert.equal(
      (await ack(caller.s, EVENTS.CALL_OFFER, { roomId: 'nope', sdp: OFFER })).code,
      'VALIDATION_ERROR',
    );
    const huge = { type: 'offer', sdp: 'x'.repeat(20001) };
    assert.equal(
      (await ack(caller.s, EVENTS.CALL_OFFER, { roomId, sdp: huge })).code,
      'VALIDATION_ERROR',
    );
  });
});

describe('call lifecycle (17.7 / 17.8 / 17.15 / 17.16)', () => {
  it('connect -> active; end -> duration, aura, Call doc, presence released, both notified', async () => {
    const { caller, callee, roomId } = await setupCall();
    const res = await ack(callee.s, EVENTS.CALL_CONNECTED, { roomId });
    assert.equal(res.ok, true);
    assert.equal((await Call.findById(roomId)).status, 'active');
    // pretend the call has been going for 2 min 5 s
    await store.hset(callSession.keys.call(roomId), 'startedAt', Date.now() - 125000);

    const end = await ack(caller.s, EVENTS.CALL_END, { roomId });
    assert.equal(end.durationSec, 125);
    assert.equal(end.auraEarned, 2);
    const [e1, e2] = await Promise.all([
      waitFor(caller.s, EVENTS.CALL_ENDED),
      waitFor(callee.s, EVENTS.CALL_ENDED),
    ]);
    assert.deepEqual(
      { d: e1.durationSec, a: e1.auraEarned, r: e1.endReason, by: e1.endedBy },
      { d: 125, a: 2, r: 'hangup', by: caller.uid },
    );
    assert.equal(e2.roomId, roomId);

    const doc = await Call.findById(roomId).lean();
    assert.deepEqual(
      { s: doc.status, d: doc.durationSec, a: doc.auraEarned, r: doc.endReason },
      { s: 'ended', d: 125, a: 2, r: 'hangup' },
    );
    assert.equal((await User.findById(caller.uid)).aura, 2);
    assert.equal((await User.findById(callee.uid)).aura, 2);
    assert.notEqual((await presence.getPresence(caller.uid)).state, presence.STATE.IN_CALL);
    assert.equal(await callSession.getCall(roomId), null);

    // ending twice is harmless
    const again = await ack(callee.s, EVENTS.CALL_END, { roomId });
    assert.equal(again.ok, false); // call no longer exists -> NOT_IN_CALL
  });

  it('a call that never connected ends as cancelled with 0 duration', async () => {
    const { caller, roomId } = await setupCall();
    const end = await ack(caller.s, EVENTS.CALL_END, { roomId });
    assert.deepEqual({ d: end.durationSec, s: end.status }, { d: 0, s: 'cancelled' });
  });

  it('call:connected from both sides keeps the first start time', async () => {
    const { caller, callee, roomId } = await setupCall();
    const a = await ack(caller.s, EVENTS.CALL_CONNECTED, { roomId });
    await sleep(30);
    const b = await ack(callee.s, EVENTS.CALL_CONNECTED, { roomId });
    assert.equal(a.startedAt, b.startedAt);
  });
});

describe('safety (17.9 / 17.11 / 17.14)', () => {
  it('rejects signaling when either user blocked the other and ends the call', async () => {
    const { caller, callee, roomId } = await setupCall();
    await Block.create({ blockerId: callee.uid, blockedId: caller.uid });
    const res = await ack(caller.s, EVENTS.CALL_OFFER, { roomId, sdp: OFFER });
    assert.equal(res.code, 'CALL_NOT_ALLOWED');
    assert.equal((await waitFor(caller.s, EVENTS.CALL_ENDED)).endReason, 'blocked');
  });

  it('blocking someone during a call ends it immediately', async () => {
    const { caller, callee, roomId } = await setupCall();
    await blockService.blockUser(caller.uid, callee.uid);
    const ended = await waitFor(callee.s, EVENTS.CALL_ENDED);
    assert.equal(ended.endReason, 'blocked');
    assert.equal(ended.roomId, roomId);
  });

  it('ends the call with peer_lost when a participant does not come back in time', async () => {
    const { caller, callee } = await setupCall();
    callee.s.disconnect();
    assert.equal((await waitFor(caller.s, EVENTS.CALL_PEER_STATUS)).status, 'reconnecting');
    const ended = await waitFor(caller.s, EVENTS.CALL_ENDED, 2000);
    assert.equal(ended.endReason, 'peer_lost');
    assert.equal(ended.endedBy, callee.uid);
  });

  it('a reconnect inside the grace period keeps the call', async () => {
    const { caller, callee, roomId } = await setupCall();
    callee.s.disconnect();
    await waitFor(caller.s, EVENTS.CALL_PEER_STATUS);
    caller.s.received = [];
    const back = await connect(callee.token);
    assert.equal((await waitFor(caller.s, EVENTS.CALL_PEER_STATUS)).status, 'connected');
    await sleep(500);
    assert.equal(got(caller.s, EVENTS.CALL_ENDED).length, 0);
    // the new device is now the one that receives signaling
    await ack(caller.s, EVENTS.CALL_ICE, { roomId, candidate: CAND });
    assert.ok(await waitFor(back, EVENTS.CALL_ICE));
  });

  it('ends calls that hit the max duration', async () => {
    callSession.settings.maxDurationMs = 200;
    const { caller } = await setupCall();
    assert.equal((await waitFor(caller.s, EVENTS.CALL_ENDED)).endReason, 'max_duration');
  });
});

describe('GET /calls/ice-servers (17.12 / 18.13)', () => {
  it('returns STUN + TURN with a valid time-limited HMAC credential', async () => {
    const { user, token } = await makeUser('ice@t.io');
    const res = await request(app)
      .get('/api/v1/calls/ice-servers')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const { iceServers, ttl, turn } = res.body.data;
    assert.equal(turn, true);
    assert.equal(ttl, 3600);
    const turnServer = iceServers.find((s) => s.username);
    const [expiry, uid] = turnServer.username.split(':');
    assert.equal(uid, String(user._id));
    assert.ok(Number(expiry) > Date.now() / 1000 + 3500);
    const expected = crypto
      .createHmac('sha1', 'turn-shared-secret-for-tests')
      .update(turnServer.username)
      .digest('base64');
    assert.equal(turnServer.credential, expected);
    assert.ok(turnServer.urls.includes('turns:turn.test.local:5349?transport=tcp'));
    assert.ok(iceServers.some((s) => s.urls.includes('stun:stun.l.google.com:19302')));
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('requires login', async () => {
    assert.equal((await request(app).get('/api/v1/calls/ice-servers')).status, 401);
  });
});
