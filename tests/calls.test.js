// Phase 12: call history, delete-for-me, block (basic).
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { Call, Block, User } = require('../src/models');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

let me;
let token;
let sourav;
let meera;

const api = (method, url) =>
  request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);

const call = (fields, minutesAgo) =>
  Call.create({
    mode: 'audio',
    matchType: 'random',
    status: 'ended',
    durationSec: 851,
    auraEarned: 14,
    ...fields,
    createdAt: new Date(Date.now() - minutesAgo * 60000),
  });

beforeEach(async () => {
  me = await createUniqueUser({ email: 'me@t.io', name: 'Riya', gender: 'female' });
  sourav = await createUniqueUser({ email: 's@t.io', name: 'Sourav', gender: 'male' });
  meera = await createUniqueUser({ email: 'm@t.io', name: 'Meera', gender: 'female' });
  token = signAccessToken(me._id);
});

describe('GET /calls/history', () => {
  it('returns my calls newest first with direction, duration, aura and the other user', async () => {
    await call({ callerId: sourav._id, calleeId: me._id }, 60 * 24 * 5); // incoming, 5d ago
    await call({ callerId: me._id, calleeId: meera._id }, 10); // outgoing
    await call(
      { callerId: meera._id, calleeId: me._id, status: 'missed', durationSec: 0, auraEarned: 0 },
      5,
    );
    await call({ callerId: sourav._id, calleeId: meera._id }, 1); // not mine

    const res = await api('get', '/calls/history');
    assert.equal(res.status, 200);
    const { items, nextCursor } = res.body.data;
    assert.equal(items.length, 3);
    assert.equal(nextCursor, null);
    assert.deepEqual(
      items.map((i) => [i.direction, i.user.name]),
      [
        ['missed', 'Meera'],
        ['outgoing', 'Meera'],
        ['incoming', 'Sourav'],
      ],
    );
    assert.equal(items[2].durationSec, 851);
    assert.equal(items[2].auraEarned, 14);
    for (const k of ['email', 'credits', 'fcmToken']) assert.ok(!(k in items[0].user));
  });

  it('pages with a stable cursor', async () => {
    for (let i = 0; i < 25; i += 1) await call({ callerId: me._id, calleeId: sourav._id }, i);
    const p1 = (await api('get', '/calls/history?limit=10')).body.data;
    const p2 = (await api('get', `/calls/history?limit=10&cursor=${p1.nextCursor}`)).body.data;
    const p3 = (await api('get', `/calls/history?limit=10&cursor=${p2.nextCursor}`)).body.data;
    assert.equal(p1.items.length, 10);
    assert.equal(p2.items.length, 10);
    assert.equal(p3.items.length, 5);
    assert.equal(p3.nextCursor, null);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    assert.equal(new Set(ids).size, 25);
  });

  it('filters by audio / text / missed', async () => {
    await call({ callerId: me._id, calleeId: sourav._id }, 3);
    await call({ callerId: me._id, calleeId: sourav._id, mode: 'text' }, 2);
    await call({ callerId: sourav._id, calleeId: me._id, status: 'missed', durationSec: 0 }, 1);
    await call({ callerId: me._id, calleeId: sourav._id, status: 'missed', durationSec: 0 }, 0); // they missed mine

    const get = async (f) => (await api('get', `/calls/history?filter=${f}`)).body.data.items;
    assert.equal((await get('audio')).length, 3);
    assert.equal((await get('text')).length, 1);
    const missed = await get('missed');
    assert.equal(missed.length, 1);
    assert.equal(missed[0].direction, 'missed');
  });

  it('searches by name or private number', async () => {
    await call({ callerId: me._id, calleeId: sourav._id }, 2);
    await call({ callerId: me._id, calleeId: meera._id }, 1);
    const byName = (await api('get', '/calls/history?q=sou')).body.data.items;
    assert.deepEqual(
      byName.map((i) => i.user.name),
      ['Sourav'],
    );
    const byNumber = (await api('get', `/calls/history?q=${meera.privateNumber.slice(0, 4)}`)).body
      .data.items;
    assert.ok(byNumber.some((i) => i.user.name === 'Meera'));
    assert.equal((await api('get', '/calls/history?q=nobody')).body.data.items.length, 0);
    // regex characters are treated literally
    assert.equal((await api('get', '/calls/history?q=.*')).status, 200);
  });

  it('marks users I blocked, never reveals users who blocked me', async () => {
    await call({ callerId: me._id, calleeId: sourav._id }, 2);
    await call({ callerId: me._id, calleeId: meera._id }, 1);
    await Block.create({ blockerId: me._id, blockedId: sourav._id });
    await Block.create({ blockerId: meera._id, blockedId: me._id });
    const items = (await api('get', '/calls/history')).body.data.items;
    const byName = Object.fromEntries(items.map((i) => [i.user.name, i.isBlocked]));
    assert.deepEqual(byName, { Sourav: true, Meera: false });
  });

  it('shows deleted accounts without their details', async () => {
    await call({ callerId: me._id, calleeId: sourav._id }, 1);
    await User.updateOne({ _id: sourav._id }, { status: 'deleted', $unset: { name: 1 } });
    const [item] = (await api('get', '/calls/history')).body.data.items;
    assert.deepEqual(item.user, { id: String(sourav._id), name: null, deleted: true });
  });

  it('rejects a tampered cursor', async () => {
    const res = await api('get', '/calls/history?cursor=not-a-cursor');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_CURSOR');
  });
});

describe('DELETE /calls/:id', () => {
  it('hides the call for me only', async () => {
    const c = await call({ callerId: me._id, calleeId: sourav._id }, 1);
    assert.equal((await api('delete', `/calls/${c._id}`)).status, 200);
    assert.equal((await api('get', '/calls/history')).body.data.items.length, 0);

    token = signAccessToken(sourav._id);
    assert.equal((await api('get', '/calls/history')).body.data.items.length, 1);
  });

  it("404s for calls that aren't mine", async () => {
    const c = await call({ callerId: sourav._id, calleeId: meera._id }, 1);
    assert.equal((await api('delete', `/calls/${c._id}`)).status, 404);
    assert.equal((await api('delete', '/calls/garbage')).status, 404);
  });
});

describe('POST /blocks', () => {
  it('blocks a user (idempotent) and rejects self / unknown users', async () => {
    assert.equal((await api('post', '/blocks').send({ userId: String(sourav._id) })).status, 200);
    assert.equal((await api('post', '/blocks').send({ userId: String(sourav._id) })).status, 200);
    assert.equal(await Block.countDocuments({ blockerId: me._id }), 1);

    const self = await api('post', '/blocks').send({ userId: String(me._id) });
    assert.equal(self.body.code, 'CANNOT_BLOCK_SELF');
    assert.equal(
      (await api('post', '/blocks').send({ userId: '64b000000000000000000000' })).status,
      404,
    );
  });
});

describe('POST /calls/:id/rating (20.10)', () => {
  it('lets each participant rate a connected call once', async () => {
    const c = await call({ callerId: me._id, calleeId: sourav._id }, 5);
    const res = await api('post', `/calls/${c._id}/rating`).send({ stars: 5 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { rated: true, stars: 5 });

    const again = await api('post', `/calls/${c._id}/rating`).send({ stars: 1 });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_RATED');

    // the other participant can rate too
    const other = await request(app)
      .post(`/api/v1/calls/${c._id}/rating`)
      .set('Authorization', `Bearer ${signAccessToken(sourav._id)}`)
      .send({ stars: 3 });
    assert.equal(other.status, 200);
    const saved = await Call.findById(c._id).lean();
    assert.deepEqual(
      saved.ratings.map((r) => [String(r.userId), r.stars]),
      [
        [String(me._id), 5],
        [String(sourav._id), 3],
      ],
    );
  });

  it("rejects calls that never connected, other people's calls and bad input", async () => {
    const missed = await call(
      { callerId: sourav._id, calleeId: me._id, status: 'missed', durationSec: 0 },
      5,
    );
    const r1 = await api('post', `/calls/${missed._id}/rating`).send({ stars: 4 });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, 'CALL_NOT_RATABLE');

    const notMine = await call({ callerId: sourav._id, calleeId: meera._id }, 5);
    const r2 = await api('post', `/calls/${notMine._id}/rating`).send({ stars: 4 });
    assert.equal(r2.status, 404);

    const r3 = await api('post', '/calls/nope/rating').send({ stars: 4 });
    assert.equal(r3.status, 404);

    const mine = await call({ callerId: me._id, calleeId: sourav._id }, 5);
    for (const stars of [0, 6, 2.5, 'x']) {
      const r = await api('post', `/calls/${mine._id}/rating`).send({ stars });
      assert.equal(r.status, 400, `stars=${stars}`);
    }
  });
});
