// Phase 34.3: admin moderation - review reports, flagged users, suspend / unsuspend.
process.env.ADMIN_API_KEY = 'test-admin-key-moderation-0123456'; // this file only (own process)
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken, issueTokens } = require('../src/services/token.service');
const { Report, Session, User } = require('../src/models');

const KEY = process.env.ADMIN_API_KEY;
const admin = (method, path) =>
  request(app)[method](`/api/v1/admin${path}`).set('X-Admin-Key', KEY);

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

const setup = async () => {
  const a = await createUniqueUser({ email: 'a@t.io', name: 'Asha', gender: 'female' });
  const b = await createUniqueUser({ email: 'b@t.io', name: 'Bad', gender: 'male' });
  await Report.create([
    { reporterId: a._id, reportedId: b._id, reason: 'harassment', note: 'rude' },
    { reporterId: a._id, reportedId: b._id, reason: 'spam', status: 'dismissed' },
  ]);
  await User.updateOne({ _id: b._id }, { flaggedAt: new Date(), flagReason: '5 reports in 24h' });
  return { a, b };
};

describe('admin moderation', () => {
  it('needs the admin key', async () => {
    assert.equal((await request(app).get('/api/v1/admin/reports')).status, 401);
    assert.equal(
      (await request(app).get('/api/v1/admin/reports').set('X-Admin-Key', 'wrong')).status,
      401,
    );
  });

  it('lists open reports with both people; status can change', async () => {
    const { b } = await setup();
    const open = (await admin('get', '/reports')).body.data.items;
    assert.equal(open.length, 1);
    assert.equal(open[0].reason, 'harassment');
    assert.equal(open[0].reporter.name, 'Asha');
    assert.equal(open[0].reported.id, String(b._id));
    assert.equal(open[0].reported.email, undefined); // no private data
    assert.equal((await admin('get', '/reports?status=dismissed')).body.data.items.length, 1);
    const upd = await admin('patch', `/reports/${open[0].id}`).send({ status: 'reviewed' });
    assert.equal(upd.body.data.status, 'reviewed');
    assert.equal((await admin('get', '/reports')).body.data.items.length, 0);
    assert.equal((await admin('patch', '/reports/nope').send({ status: 'reviewed' })).status, 404);
  });

  it('flagged users with report counts', async () => {
    await setup();
    const items = (await admin('get', '/users/flagged')).body.data.items;
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].reports, { total: 2, open: 1 });
    assert.equal(items[0].flagReason, '5 reports in 24h');
  });

  it('suspend locks the account out; unsuspend brings it back', async () => {
    const { b } = await setup();
    await issueTokens({ userId: b._id });
    const token = signAccessToken(b._id);
    const res = await admin('post', `/users/${b._id}/suspend`).send({ reason: 'harassment' });
    assert.equal(res.body.data.status, 'suspended');
    assert.equal(await Session.countDocuments({ userId: b._id, revokedAt: null }), 0);
    assert.equal(await Report.countDocuments({ reportedId: b._id, status: 'open' }), 0);
    const me = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.status, 403);

    await admin('post', `/users/${b._id}/unsuspend`).send({});
    const u = await User.findById(b._id).lean();
    assert.equal(u.status, 'active');
    assert.equal(u.flaggedAt, undefined);
    assert.equal(
      (await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`)).status,
      200,
    );
    assert.equal((await admin('post', '/users/nope/suspend').send({ reason: 'xyz' })).status, 404);
  });
});
