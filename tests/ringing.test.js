// Phase 21: ringing direct calls (socket + push), accept / decline / missed, push service.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Call, User } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const callSession = require('../src/services/callSession.service');
const ringing = require('../src/services/ringing.service');
const push = require('../src/services/push.service');
const EVENTS = require('../src/constants/socketEvents.json');

let server;
let url;
let pushes; // [{ token, data, ttlMs }]
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'fcm-token-of-the-callee-device-0123456789';

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
const pushesOf = (type) => pushes.filter((p) => p.data.type === type);

let caller;
let callee;

const makeUser = async (email, name, fields = {}) => {
  const user = await createUniqueUser({ email, name, gender: 'female' });
  if (Object.keys(fields).length) await User.updateOne({ _id: user._id }, { $set: fields });
  return { user, uid: String(user._id), token: signAccessToken(user._id) };
};

// a direct call as Phase 22 will create it
const ring = async () => {
  const call = await Call.create({
    callerId: caller.uid,
    calleeId: callee.uid,
    mode: 'audio',
    matchType: 'direct',
    status: 'ringing',
  });
  const roomId = String(call._id);
  const res = await ringing.startRinging({
    roomId,
    caller: caller.user,
    calleeId: callee.uid,
    mode: 'audio',
  });
  return { roomId, res };
};

before(async () => {
  Object.assign(callSession.settings, { peerLostGraceMs: 200, maxDurationMs: 3600000 });
  presence.settings.offlineGraceMs = 100;
  ringing.settings.ringTimeoutMs = 600;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  pushes = [];
  push.__setTransportForTests(async (msg) => {
    pushes.push(msg);
    return `msg-${pushes.length}`;
  });
  caller = await makeUser('caller@t.io', 'Riya');
  callee = await makeUser('callee@t.io', 'Sourav', { fcmToken: TOKEN });
  caller.s = await connect(caller.token);
});

afterEach(async () => {
  ringing.__resetForTests();
  callSession.__resetForTests();
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(async () => {
  push.__setTransportForTests(null);
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('ringing (21.4)', () => {
  it('online callee: call:incoming on every device + push; caller gets call:ringing', async () => {
    const d1 = await connect(callee.token);
    const d2 = await connect(callee.token);
    await sleep(60);
    const { roomId, res } = await ring();
    assert.equal(res.delivered, 'socket');
    for (const d of [d1, d2]) {
      const inc = await waitFor(d, EVENTS.CALL_INCOMING);
      assert.equal(inc.roomId, roomId);
      assert.equal(inc.caller.name, 'Riya');
      assert.ok(inc.expiresAt > Date.now());
    }
    const r = await waitFor(caller.s, EVENTS.CALL_RINGING);
    assert.equal(r.delivered, 'socket');
    const [p] = pushesOf('incoming_call');
    assert.equal(p.token, TOKEN);
    assert.equal(p.data.roomId, roomId);
    assert.equal(p.data.callerName, 'Riya');
    assert.ok(Object.values(p.data).every((v) => typeof v === 'string')); // FCM rule
    assert.equal(p.ttlMs, 1000); // ceil(0.6 s)
  });

  it('offline callee: push only; no token -> delivered none', async () => {
    const { res } = await ring();
    assert.equal(res.delivered, 'push');
    await User.updateOne({ _id: callee.uid }, { $unset: { fcmToken: 1 } });
    ringing.__resetForTests();
    await callSession.endCall((await Call.findOne().lean())._id.toString(), { reason: 'hangup' });
    const second = await ring();
    assert.equal(second.res.delivered, 'none');
  });

  it('a device that connects while it rings gets the ring (app opened from the push)', async () => {
    const { roomId } = await ring();
    const d = await connect(callee.token);
    const inc = await waitFor(d, EVENTS.CALL_INCOMING);
    assert.equal(inc.roomId, roomId);
  });

  it('a ringing callee going offline does not end the call (no peer-lost)', async () => {
    const d = await connect(callee.token);
    await sleep(60);
    const { roomId } = await ring();
    d.disconnect();
    await sleep(350); // > peer-lost grace (200 ms), < ring timeout (600 ms)
    assert.ok(await callSession.getCall(roomId));
    assert.equal(got(caller.s, EVENTS.CALL_ENDED).length, 0);
  });
});

describe('answer / decline (21.9 / 21.10)', () => {
  it('accept: caller gets call:accept, other devices stop ringing, signaling goes to that device', async () => {
    const d1 = await connect(callee.token);
    const d2 = await connect(callee.token);
    await sleep(60);
    const { roomId } = await ring();
    await waitFor(d1, EVENTS.CALL_INCOMING);

    const res = await ack(d1, EVENTS.CALL_ACCEPT, { roomId });
    assert.equal(res.ok, true);
    assert.equal(res.role, 'callee');
    assert.equal(res.peer.name, 'Riya');

    const acc = await waitFor(caller.s, EVENTS.CALL_ACCEPT);
    assert.equal(acc.roomId, roomId);
    assert.equal(acc.role, 'caller');
    assert.equal(acc.peer.name, 'Sourav');
    assert.equal((await waitFor(d2, EVENTS.CALL_RING_STOPPED)).reason, 'answered');
    assert.equal(pushesOf('call_cancelled')[0].data.reason, 'answered');
    assert.equal((await presence.getPresence(callee.uid)).state, presence.STATE.IN_CALL);

    // second answer loses
    assert.equal((await ack(d2, EVENTS.CALL_ACCEPT, { roomId })).code, 'CALL_NOT_RINGING');

    // the offer reaches only the answering device
    const OFFER = { type: 'offer', sdp: 'v=0\r\n' };
    assert.equal((await ack(caller.s, EVENTS.CALL_OFFER, { roomId, sdp: OFFER })).ok, true);
    await waitFor(d1, EVENTS.CALL_OFFER);
    await sleep(80);
    assert.equal(got(d2, EVENTS.CALL_OFFER).length, 0);

    // answered calls are not missed later
    await sleep(700);
    assert.ok(await callSession.getCall(roomId));
  });

  it('decline over the socket ends the call as declined', async () => {
    const d = await connect(callee.token);
    await sleep(60);
    const { roomId } = await ring();
    const res = await ack(d, EVENTS.CALL_DECLINE, { roomId });
    assert.deepEqual({ ok: res.ok, declined: res.declined }, { ok: true, declined: true });
    const ended = await waitFor(caller.s, EVENTS.CALL_ENDED);
    assert.equal(ended.endReason, 'declined');
    assert.equal(ended.status, 'declined');
    assert.equal((await waitFor(d, EVENTS.CALL_RING_STOPPED)).reason, 'declined');
    assert.equal((await Call.findById(roomId).lean()).status, 'declined');
    assert.equal(pushesOf('missed_call').length, 0);
    assert.notEqual((await presence.getPresence(caller.uid)).state, presence.STATE.IN_CALL);
  });

  it('decline from the notification (REST), only by the callee', async () => {
    const { roomId } = await ring();
    const bad = await request(app)
      .post(`/api/v1/calls/${roomId}/decline`)
      .set('Authorization', `Bearer ${caller.token}`);
    assert.equal(bad.status, 403);
    const res = await request(app)
      .post(`/api/v1/calls/${roomId}/decline`)
      .set('Authorization', `Bearer ${callee.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.declined, true);
    assert.equal((await waitFor(caller.s, EVENTS.CALL_ENDED)).endReason, 'declined');
    const again = await request(app)
      .post(`/api/v1/calls/${roomId}/decline`)
      .set('Authorization', `Bearer ${callee.token}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'CALL_NOT_RINGING');
  });
});

describe('missed calls (21.12 / 21.13)', () => {
  it('no answer in time -> missed, ringing stopped, missed-call push', async () => {
    const d = await connect(callee.token);
    await sleep(60);
    const { roomId } = await ring();
    const ended = await waitFor(caller.s, EVENTS.CALL_ENDED, 3000);
    assert.equal(ended.endReason, 'no_answer');
    assert.equal(ended.status, 'missed');
    assert.equal((await waitFor(d, EVENTS.CALL_RING_STOPPED)).reason, 'cancelled');
    await sleep(50);
    assert.equal(pushesOf('call_cancelled').length, 1);
    const [missed] = pushesOf('missed_call');
    assert.equal(missed.data.callerName, 'Riya');
    const doc = await Call.findById(roomId).lean();
    assert.equal(doc.status, 'missed');
    assert.notEqual((await presence.getPresence(caller.uid)).state, presence.STATE.IN_CALL);
  });

  it('caller hanging up while it rings -> missed call for the callee', async () => {
    const { roomId } = await ring();
    const res = await ack(caller.s, EVENTS.CALL_END, { roomId });
    assert.equal(res.status, 'missed');
    await sleep(80);
    assert.equal(pushesOf('call_cancelled')[0].data.reason, 'cancelled');
    assert.equal(pushesOf('missed_call').length, 1);
    // nothing fires again when the old ring timer would have expired
    await sleep(700);
    assert.equal(pushesOf('missed_call').length, 1);
  });

  it('random-match calls are never "missed"', async () => {
    const call = await Call.create({
      callerId: caller.uid,
      calleeId: callee.uid,
      mode: 'audio',
      matchType: 'random',
    });
    const roomId = String(call._id);
    await callSession.registerCall({
      roomId,
      callerId: caller.uid,
      calleeId: callee.uid,
      mode: 'audio',
    });
    const summary = await callSession.endCall(roomId, { reason: 'hangup' });
    assert.equal(summary.status, 'cancelled');
    assert.equal(pushes.length, 0);
  });
});

describe('push service', () => {
  it('drops a token FCM says is dead', async () => {
    push.__setTransportForTests(async () => {
      const err = new Error('gone');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    });
    const res = await push.sendToUser(callee.uid, push.PUSH.MISSED_CALL, { roomId: 'x' });
    assert.deepEqual(res, { sent: false, reason: 'messaging/registration-token-not-registered' });
    assert.equal((await User.findById(callee.uid).lean()).fcmToken, undefined);
  });

  it('is a no-op when FCM is not configured', async () => {
    push.__setTransportForTests(null);
    assert.deepEqual(await push.sendToUser(callee.uid, 'x'), { sent: false, reason: 'disabled' });
  });

  it('reads the service account as JSON, base64 or a file path', () => {
    const json = { project_id: 'p', client_email: 'a@b', private_key: 'k' };
    assert.deepEqual(push.readServiceAccount(JSON.stringify(json)), json);
    assert.deepEqual(
      push.readServiceAccount(Buffer.from(JSON.stringify(json)).toString('base64')),
      json,
    );
    assert.equal(push.readServiceAccount(''), null);
  });

  it('DELETE /users/me/fcm-token detaches this device', async () => {
    const res = await request(app)
      .delete('/api/v1/users/me/fcm-token')
      .set('Authorization', `Bearer ${callee.token}`);
    assert.equal(res.status, 200);
    assert.equal((await User.findById(callee.uid).lean()).fcmToken, undefined);
  });
});
