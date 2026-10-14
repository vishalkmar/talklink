// Phase 22: POST /calls/direct (blocks, privacy, busy, rate limit) + PATCH /users/me/settings.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Call, Block, User } = require('../src/models');
const presence = require('../src/services/presence.service');
const callSession = require('../src/services/callSession.service');
const ringing = require('../src/services/ringing.service');
const directCall = require('../src/services/directCall.service');
const push = require('../src/services/push.service');

let riya;
let sourav;
let meera;

const makeUser = async (email, name) => {
  const user = await createUniqueUser({ email, name, gender: 'female' });
  return { user, uid: String(user._id), token: signAccessToken(user._id) };
};
const call = (from, calleeId, body = {}) =>
  request(app)
    .post('/api/v1/calls/direct')
    .set('Authorization', `Bearer ${from.token}`)
    .send({ calleeId, ...body });

before(async () => {
  ringing.settings.ringTimeoutMs = 60000;
  await connectTestDeps();
});

beforeEach(async () => {
  push.__setTransportForTests(null);
  directCall.settings.perHour = 20;
  riya = await makeUser('riya@t.io', 'Riya');
  sourav = await makeUser('sourav@t.io', 'Sourav');
  meera = await makeUser('meera@t.io', 'Meera');
});

afterEach(async () => {
  ringing.__resetForTests();
  callSession.__resetForTests();
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(closeTestDeps);

describe('POST /calls/direct (22.5 - 22.7, 22.15)', () => {
  it('creates a direct Call and starts ringing', async () => {
    const res = await call(riya, sourav.uid);
    assert.equal(res.status, 201);
    const d = res.body.data;
    assert.equal(d.mode, 'audio');
    assert.equal(d.delivered, 'none'); // callee offline, push disabled
    assert.equal(d.peer.name, 'Sourav');
    assert.equal(d.peer.email, undefined);
    assert.ok(d.expiresAt > Date.now());
    const doc = await Call.findById(d.roomId).lean();
    assert.equal(doc.matchType, 'direct');
    assert.equal(doc.status, 'ringing');
    assert.ok(await ringing.getRing(d.roomId));
    assert.equal((await presence.getPresence(riya.uid)).state, presence.STATE.IN_CALL);
  });

  it('unknown, self, blocked (either way) -> not found / not allowed', async () => {
    assert.equal((await call(riya, '64b000000000000000000000')).body.code, 'USER_NOT_FOUND');
    assert.equal((await call(riya, 'nope')).status, 404);
    assert.equal((await call(riya, riya.uid)).body.code, 'CANNOT_CALL_SELF');
    await Block.create({ blockerId: sourav.uid, blockedId: riya.uid });
    const blocked = await call(riya, sourav.uid);
    assert.equal(blocked.status, 404); // a block is never revealed
    assert.equal(blocked.body.code, 'USER_NOT_FOUND');
    assert.equal(await Call.countDocuments(), 0);
  });

  it('busy callee -> USER_BUSY; caller busy -> BUSY', async () => {
    const first = await call(riya, sourav.uid);
    assert.equal(first.status, 201);
    const second = await call(meera, sourav.uid); // Sourav already has a call ringing
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'USER_BUSY');
    const third = await call(riya, meera.uid); // Riya is in her own call
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'BUSY');

    await presence.setBusy(meera.uid, presence.STATE.IN_CALL);
    const k = await makeUser('k@t.io', 'Kabir');
    assert.equal((await call(k, meera.uid)).body.code, 'USER_BUSY');
  });

  it('after the call ends both can be called again', async () => {
    const first = await call(riya, sourav.uid);
    await callSession.endCall(first.body.data.roomId, { reason: 'hangup' });
    assert.equal((await call(meera, sourav.uid)).status, 201);
  });

  it('rate limit: max DIRECT_CALLS_PER_HOUR per caller (22.12)', async () => {
    directCall.settings.perHour = 2;
    for (let i = 0; i < 2; i += 1) {
      const r = await call(riya, sourav.uid);
      assert.equal(r.status, 201);
      await callSession.endCall(r.body.data.roomId, { reason: 'hangup' });
    }
    const limited = await call(riya, sourav.uid);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
  });

  it('only audio for now', async () => {
    assert.equal((await call(riya, sourav.uid, { mode: 'text' })).status, 400);
  });
});

describe('who can call me (22.11)', () => {
  const setPrivacy = (u, directCalls) =>
    request(app)
      .patch('/api/v1/users/me/settings')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ directCalls });

  it('nobody -> CALLS_NOT_ALLOWED', async () => {
    const res = await setPrivacy(sourav, 'nobody');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.settings.directCalls, 'nobody');
    const r = await call(riya, sourav.uid);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CALLS_NOT_ALLOWED');
  });

  it('past matches -> only people who talked before', async () => {
    await setPrivacy(sourav, 'past_matches');
    assert.equal((await call(riya, sourav.uid)).body.code, 'CALLS_NOT_ALLOWED');
    await Call.create({
      callerId: sourav.uid,
      calleeId: riya.uid,
      mode: 'audio',
      matchType: 'random',
      status: 'ended',
      startedAt: new Date(),
      durationSec: 90,
    });
    assert.equal((await call(riya, sourav.uid)).status, 201);
  });

  it('validates the setting; GET /users/me shows it', async () => {
    assert.equal((await setPrivacy(riya, 'friends')).status, 400);
    const empty = await request(app)
      .patch('/api/v1/users/me/settings')
      .set('Authorization', `Bearer ${riya.token}`)
      .send({});
    assert.equal(empty.status, 400);
    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${riya.token}`);
    assert.equal(me.body.data.user.settings.directCalls, 'everyone');
    assert.equal((await User.findById(riya.uid).lean()).settings.directCalls, 'everyone');
  });
});
