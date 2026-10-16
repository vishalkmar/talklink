const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Status, Conversation, Call } = require('../src/models');
const status = require('../src/services/status.service');
const media = require('../src/services/media.service');
const { blockUser } = require('../src/services/block.service');

const originalSettings = { ...media.settings };
const originalInspect = media.inspectResource;
let me, friend, stranger, destroyed;
let assetOverrides;
const make = (name) => createUniqueUser({ email: `${name}@test.io`, name, gender: 'female' });
const api = (user, method, path) =>
  request(app)
    [method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${signAccessToken(user._id)}`);
const reserve = async (user = me, kind = 'status_image') => status.reserveUpload(user._id, kind);
const post = async (user = me, kind = 'status_image') => {
  const signed = await reserve(user, kind);
  return status.publish(user._id, { statusId: signed.statusId, caption: 'Hello' });
};
before(connectTestDeps);
beforeEach(async () => {
  Object.assign(media.settings, {
    cloudName: 'testcloud',
    apiKey: '111',
    apiSecret: 'test-secret',
  });
  destroyed = [];
  assetOverrides = {};
  media.__setTransportForTests(async (endpoint, form) => {
    destroyed.push(form.public_id);
    return { status: 200, data: { result: 'ok' } };
  });
  media.inspectResource = async (publicId, type) => ({
    public_id: publicId,
    resource_type: type,
    bytes: 1024,
    format: type === 'video' ? 'mp4' : 'jpg',
    width: 720,
    height: 1280,
    duration: 20,
    secure_url: `https://res.cloudinary.com/testcloud/${type}/upload/v1/${publicId}.${type === 'video' ? 'mp4' : 'jpg'}`,
    ...assetOverrides,
  });
  [me, friend, stranger] = await Promise.all(['Meera', 'Riya', 'Sana'].map(make));
  await Conversation.create({
    participants: [me._id, friend._id],
    participantsKey: Conversation.keyFor(me._id, friend._id),
    lastMessage: { text: 'Hi', senderId: me._id, createdAt: new Date() },
  });
});
afterEach(async () => {
  Object.assign(media.settings, originalSettings);
  media.inspectResource = originalInspect;
  await resetTestDeps();
});
after(closeTestDeps);

describe('status lifecycle and privacy', () => {
  it('requires auth, validates ids, signs a tracked non-overwriting upload without exposing secret', async () => {
    assert.equal((await request(app).get('/api/v1/statuses')).status, 401);
    assert.equal((await api(me, 'get', '/statuses/not-an-id')).status, 400);
    const res = await api(me, 'post', '/media/sign').send({ kind: 'status_video' });
    assert.equal(res.status, 200);
    const signed = res.body.data;
    assert.equal(signed.params.overwrite, 'false');
    assert.equal(signed.signature, media.sign(signed.params));
    assert.ok(await Status.exists({ _id: signed.statusId, owner: me._id, state: 'pending' }));
    assert.equal(JSON.stringify(signed).includes('test-secret'), false);
    assert.deepEqual((await status.list(friend._id)).items, []);
  });
  it('publishes photos for 24h, lists only contacts, and retries publish idempotently', async () => {
    const signed = await reserve();
    const res = await api(me, 'post', '/statuses').send({
      statusId: signed.statusId,
      caption: 'A photo',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.durationSec, 30);
    assert.equal(new Date(res.body.data.expiresAt) - new Date(res.body.data.createdAt), 86400000);
    assert.equal((await status.list(friend._id)).items[0].items[0].caption, 'A photo');
    assert.equal((await status.list(stranger._id)).items.length, 0);
    assert.equal((await api(stranger, 'get', `/statuses/${signed.statusId}`)).status, 404);
    assert.equal((await status.publish(me._id, { statusId: signed.statusId })).id, signed.statusId);
    assert.equal(await Status.countDocuments({ state: 'active' }), 1);
  });
  it('accepts connected calls but excludes missed calls and empty conversations', async () => {
    await Conversation.deleteMany({});
    await Conversation.create({
      participants: [me._id, stranger._id],
      participantsKey: Conversation.keyFor(me._id, stranger._id),
    });
    await Call.create({
      callerId: me._id,
      calleeId: stranger._id,
      mode: 'audio',
      matchType: 'direct',
      status: 'missed',
    });
    await Call.create({
      callerId: me._id,
      calleeId: friend._id,
      mode: 'audio',
      matchType: 'direct',
      status: 'ended',
      startedAt: new Date(),
    });
    await post();
    assert.equal((await status.list(friend._id)).items.length, 1);
    assert.equal((await status.list(stranger._id)).items.length, 0);
  });
  it('cannot publish another account upload or use an arbitrary URL', async () => {
    const signed = await reserve();
    assert.equal(
      (await api(friend, 'post', '/statuses').send({ statusId: signed.statusId })).status,
      404,
    );
    assetOverrides = { secure_url: 'https://example.com/photo.jpg' };
    await assert.rejects(status.publish(me._id, { statusId: signed.statusId }), {
      code: 'INVALID_MEDIA',
    });
  });
  it('verifies actual duration, size and media type on the server', async () => {
    const signed = await reserve(me, 'status_video');
    for (const bad of [
      { duration: 30.01 },
      { bytes: 31 * 1024 * 1024 },
      { width: 0 },
      { resource_type: 'image' },
    ]) {
      assetOverrides = bad;
      await assert.rejects(status.publish(me._id, { statusId: signed.statusId }), {
        code: 'INVALID_STATUS_MEDIA',
      });
    }
    assetOverrides = { duration: 30 };
    assert.equal((await status.publish(me._id, { statusId: signed.statusId })).durationSec, 30);
  });
  it('enforces three active statuses under concurrent publishing', async () => {
    const uploads = await Promise.all(Array.from({ length: 6 }, () => reserve()));
    const result = await Promise.allSettled(
      uploads.map((s) => status.publish(me._id, { statusId: s.statusId })),
    );
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(await Status.countDocuments({ owner: me._id, state: 'active' }), 3);
    result
      .filter((r) => r.status === 'rejected')
      .forEach((r) => assert.equal(r.reason.code, 'STATUS_LIMIT'));
    assert.equal((await api(me, 'post', '/media/sign').send({ kind: 'status_image' })).status, 409);
  });
  it('deduplicates viewers and exposes their identities only to the owner', async () => {
    const s = await post();
    await Promise.all(Array.from({ length: 4 }, () => status.seen(friend._id, s.id)));
    await status.seen(me._id, s.id);
    assert.equal((await status.viewers(me._id, s.id)).items.length, 1);
    assert.equal((await api(friend, 'get', `/statuses/${s.id}/viewers`)).status, 404);
    assert.equal((await status.list(friend._id)).items[0].items[0].seen, true);
  });
  it('blocks status listing, opening, seen and download authorization in both directions', async () => {
    const s = await post();
    await blockUser(friend._id, me._id);
    assert.equal((await status.list(friend._id)).items.length, 0);
    assert.equal((await status.list(me._id)).items.length, 0);
    assert.equal((await api(friend, 'get', `/statuses/${s.id}`)).status, 404);
    assert.equal((await api(friend, 'post', `/statuses/${s.id}/seen`)).status, 404);
  });
  it('expires immediately, retries cloud cleanup, and frees expired slots', async () => {
    const s = await post();
    await Status.updateOne(
      { _id: s.id },
      { expiresAt: new Date(Date.now() - 1), uploadExpiresAt: new Date(Date.now() - 1) },
    );
    assert.equal((await status.list(friend._id)).items.length, 0);
    assert.equal((await api(friend, 'get', `/statuses/${s.id}`)).status, 404);
    media.__setTransportForTests(async () => ({ status: 503, data: {} }));
    assert.equal((await status.purge()).deleted, 0);
    assert.ok(await Status.exists({ _id: s.id, state: 'deleting' }));
    await Promise.all([post(), post(), post()]);
    media.__setTransportForTests(async () => ({ status: 200, data: { result: 'ok' } }));
    assert.equal((await status.purge()).deleted, 1);
    assert.equal(await Status.exists({ _id: s.id }), null);
  });
  it('only the owner can delete; cloud failure hides it and leaves a retry receipt', async () => {
    const s = await post();
    assert.equal((await api(friend, 'delete', `/statuses/${s.id}`)).status, 404);
    media.__setTransportForTests(async () => ({ status: 503, data: {} }));
    assert.equal((await api(me, 'delete', `/statuses/${s.id}`)).status, 200);
    assert.equal((await status.list(friend._id)).items.length, 0);
    assert.ok(await Status.exists({ _id: s.id, state: 'deleting' }));
  });
  it('purges abandoned uploads after signature expiry without dropping receipts early', async () => {
    const signed = await reserve();
    assert.equal((await status.purge()).deleted, 0);
    await Status.updateOne(
      { _id: signed.statusId },
      { expiresAt: new Date(Date.now() - 1), uploadExpiresAt: new Date(Date.now() - 1) },
    );
    assert.equal((await status.purge()).deleted, 1);
    assert.equal(destroyed.length, 1);
  });

  it('retains an early-delete receipt until the upload signature expires', async () => {
    const s = await post();
    await status.remove(me._id, s.id);
    const receipt = await Status.findById(s.id).lean();
    assert.equal(receipt.state, 'deleting');
    assert.equal(receipt.url, undefined);
    assert.equal(receipt.caption, '');
    assert.deepEqual(receipt.viewers, []);
    assert.equal((await status.purge()).deleted, 0);
    await Status.updateOne({ _id: s.id }, { uploadExpiresAt: new Date(Date.now() - 1) });
    assert.equal((await status.purge()).deleted, 1);
    assert.equal(await Status.exists({ _id: s.id }), null);
  });
});
