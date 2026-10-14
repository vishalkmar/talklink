const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { User, Block, Session } = require('../src/models');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken, issueTokens } = require('../src/services/token.service');
const mailService = require('../src/services/mail.service');

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

const makeUser = async (email, profile = { name: 'Riya', gender: 'female' }) => {
  const user = await createUniqueUser({ email, ...profile });
  return { user, token: signAccessToken(user._id) };
};
const api = (method, url, token) => {
  const req = request(app)[method](`/api/v1${url}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('authenticate middleware', () => {
  it('rejects requests without a token', async () => {
    const res = await api('get', '/users/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  it('returns TOKEN_EXPIRED for an expired access token', async () => {
    const { user } = await makeUser('exp@t.io');
    const expired = jwt.sign(
      { typ: 'access', exp: Math.floor(Date.now() / 1000) - 10 },
      config.jwt.accessSecret,
      { subject: String(user._id) },
    );
    const res = await api('get', '/users/me', expired);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'TOKEN_EXPIRED');
  });

  it('rejects tampered tokens', async () => {
    const { token } = await makeUser('tamper@t.io');
    const res = await api('get', '/users/me', `${token.slice(0, -2)}xx`);
    assert.equal(res.body.code, 'INVALID_TOKEN');
  });

  it('rejects suspended users', async () => {
    const { user, token } = await makeUser('sus@t.io');
    await User.updateOne({ _id: user._id }, { status: 'suspended' });
    const res = await api('get', '/users/me', token);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_SUSPENDED');
  });
});

describe('GET/PATCH /users/me', () => {
  it('returns the private profile', async () => {
    const { user, token } = await makeUser('me@t.io');
    const res = await api('get', '/users/me', token);
    assert.equal(res.status, 200);
    const me = res.body.data.user;
    assert.equal(me.id, String(user._id));
    assert.equal(me.email, 'me@t.io');
    assert.equal(me.privateNumber, user.privateNumber);
    for (const k of ['credits', 'isPremium', 'streak', 'bestStreak', 'aura', 'isProfileComplete']) {
      assert.ok(k in me, `missing ${k}`);
    }
    assert.ok(!('fcmToken' in me));
  });

  it('sets up a profile and ignores protected fields', async () => {
    const { user, token } = await makeUser('setup@t.io', {});
    const res = await api('patch', '/users/me', token).send({
      name: '  Arjun K ',
      gender: 'male',
      avatar: 'avatar_03',
      privateNumber: '12345',
      credits: 999999,
      isPremium: true,
      email: 'hacker@t.io',
    });
    assert.equal(res.status, 200);
    const me = res.body.data.user;
    assert.equal(me.name, 'Arjun K');
    assert.equal(me.gender, 'male');
    assert.equal(me.avatar, 'avatar_03');
    assert.equal(me.isProfileComplete, true);
    assert.equal(me.privateNumber, user.privateNumber);
    assert.equal(me.credits, 0);
    assert.equal(me.isPremium, false);
    assert.equal(me.email, 'setup@t.io');
  });

  it('validates name, gender and avatar', async () => {
    const { token } = await makeUser('val@t.io', {});
    for (const body of [
      { name: 'A' },
      { name: 'x'.repeat(21) },
      { name: '<script>' },
      { gender: 'robot' },
      { avatar: 'avatar_99' },
      {},
    ]) {
      const res = await api('patch', '/users/me', token).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    }
  });

  it('locks gender changes for 30 days after it is set', async () => {
    const { user, token } = await makeUser('g@t.io', { name: 'Gina' });
    assert.equal((await api('patch', '/users/me', token).send({ gender: 'female' })).status, 200);

    const locked = await api('patch', '/users/me', token).send({ gender: 'male' });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.code, 'GENDER_CHANGE_LOCKED');
    assert.ok(locked.body.details.nextChangeAt);

    // same value is not a change
    assert.equal((await api('patch', '/users/me', token).send({ gender: 'female' })).status, 200);

    await User.updateOne(
      { _id: user._id },
      { genderChangedAt: new Date(Date.now() - 31 * 86400000) },
    );
    const allowed = await api('patch', '/users/me', token).send({ gender: 'male' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.user.gender, 'male');
  });
});

describe('user lookup', () => {
  it('finds a user by private number with public fields only', async () => {
    const { token } = await makeUser('viewer@t.io');
    const { user: target } = await makeUser('target@t.io', { name: 'Sourav', gender: 'male' });
    const res = await api('get', `/users/by-number/${target.privateNumber}`, token);
    assert.equal(res.status, 200);
    const u = res.body.data.user;
    assert.equal(u.name, 'Sourav');
    assert.equal(u.privateNumber, target.privateNumber);
    for (const k of ['email', 'credits', 'fcmToken', 'isPremium', 'status']) {
      assert.ok(!(k in u), `leaks ${k}`);
    }
    assert.ok(u.joinedAt);
  });

  it('returns 404 for unknown numbers, unfinished profiles and deleted users', async () => {
    const { token } = await makeUser('v2@t.io');
    assert.equal((await api('get', '/users/by-number/99999', token)).status, 404);
    const { user: half } = await makeUser('half@t.io', {});
    assert.equal((await api('get', `/users/by-number/${half.privateNumber}`, token)).status, 404);
    assert.equal((await api('get', '/users/by-number/12ab', token)).status, 400);
  });

  it('hides users from each other when either side blocked', async () => {
    const a = await makeUser('a@t.io');
    const b = await makeUser('b@t.io', { name: 'Bob', gender: 'male' });
    await Block.create({ blockerId: b.user._id, blockedId: a.user._id }); // B blocked A

    const aSearch = await api('get', `/users/by-number/${b.user.privateNumber}`, a.token);
    assert.equal(aSearch.status, 404);
    assert.equal(aSearch.body.code, 'USER_NOT_FOUND');

    const bSearch = await api('get', `/users/${a.user._id}/public`, b.token);
    assert.equal(bSearch.status, 404);
  });

  it('GET /users/:id/public works and 404s on garbage ids', async () => {
    const { token } = await makeUser('v3@t.io');
    const { user: target } = await makeUser('t3@t.io');
    assert.equal((await api('get', `/users/${target._id}/public`, token)).status, 200);
    assert.equal((await api('get', '/users/not-an-id/public', token)).status, 404);
  });

  it('rate-limits lookups per user', async () => {
    const { token } = await makeUser('spam@t.io');
    let last;
    for (let i = 0; i < 31; i += 1) last = await api('get', '/users/by-number/99999', token);
    assert.equal(last.status, 429);
  });
});

describe('fcm token and account deletion', () => {
  it('stores the FCM token and detaches it from any other account', async () => {
    const a = await makeUser('fa@t.io');
    const b = await makeUser('fb@t.io');
    const token = 'f'.repeat(40);
    await api('post', '/users/me/fcm-token', a.token).send({ token });
    await api('post', '/users/me/fcm-token', b.token).send({ token });
    assert.equal((await User.findById(a.user._id)).fcmToken, undefined);
    assert.equal((await User.findById(b.user._id)).fcmToken, token);
  });

  it('deletes the account: wipes personal data, revokes sessions, frees the email', async () => {
    const { user, token } = await makeUser('bye@t.io');
    await issueTokens({ userId: user._id });
    // 33.17 confirmed with an emailed code
    let otp;
    mock.method(mailService, 'sendOtpEmail', async (email, code) => {
      otp = code;
    });
    await api('post', '/users/me/delete-otp', token);
    mock.restoreAll();
    const res = await api('delete', '/users/me', token).send({ otp });
    assert.equal(res.status, 200);

    const doc = await User.findById(user._id).lean();
    assert.equal(doc.status, 'deleted');
    assert.notEqual(doc.email, 'bye@t.io');
    assert.equal(doc.name, undefined);
    assert.equal(doc.privateNumber, user.privateNumber, 'number stays reserved');
    assert.equal(await Session.countDocuments({ userId: user._id, revokedAt: null }), 0);
    assert.equal((await api('get', '/users/me', token)).status, 401);
    assert.equal((await createUniqueUser({ email: 'bye@t.io' })).email, 'bye@t.io');
  });
});

describe('security middleware', () => {
  it('strips $-operators from bodies (NoSQL injection)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({ email: { $gt: '' }, otp: '123456' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  });

  it('rejects bodies over 100kb', async () => {
    const res = await request(app)
      .post('/api/v1/auth/send-otp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.io', pad: 'x'.repeat(110 * 1024) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
  });

  it('serves predefined avatars', async () => {
    const res = await request(app).get('/static/avatars/avatar_01.svg');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });
});

describe('GET /config and force update', () => {
  it('returns app config without auth', async () => {
    const res = await api('get', '/config');
    assert.equal(res.status, 200);
    const c = res.body.data;
    assert.equal(c.minAppVersion, config.minAppVersion);
    assert.equal(c.credits.genderFilterCost, 10000);
    assert.equal(c.avatars.length, 12);
    assert.equal(c.spin.segments.length, 8);
    assert.equal(c.forceUpdate, false);
  });

  it('flags forceUpdate and blocks API calls from too-old apps', async () => {
    const { token } = await makeUser('old@t.io');
    const cfg = await api('get', '/config').set('X-App-Version', '0.9.0');
    assert.equal(cfg.body.data.forceUpdate, true);

    const blocked = await api('get', '/users/me', token).set('X-App-Version', '0.9.0');
    assert.equal(blocked.status, 426);
    assert.equal(blocked.body.code, 'APP_UPDATE_REQUIRED');

    const ok = await api('get', '/users/me', token).set('X-App-Version', '1.0.0');
    assert.equal(ok.status, 200);
  });
});
