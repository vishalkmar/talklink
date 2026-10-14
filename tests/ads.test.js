// Phase 28: rewarded ads - nonce, SSV signature, one reward per transaction, daily limit, dev claim.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { CreditTransaction, User } = require('../src/models');
const ads = require('../src/services/ads.service');

// our own "Google" key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';
const pem = publicKey.export({ type: 'spki', format: 'pem' });

const sign = (message) =>
  crypto
    .sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'der' })
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// builds the query string the way Google does (signature + key_id last)
const ssvQuery = ({ userId, nonce, tx, adUnit = '5224354917', tamper = false }) => {
  const parts = [
    'ad_network=5450213213286189855',
    `ad_unit=${adUnit}`,
    `custom_data=${nonce}`,
    'reward_amount=1',
    'reward_item=credits',
    `timestamp=${Date.now()}`,
    `transaction_id=${tx}`,
    `user_id=${userId}`,
  ];
  const message = parts.join('&');
  const signature = sign(message);
  const signed = tamper ? message.replace('reward_amount=1', 'reward_amount=99') : message;
  return `${signed}&signature=${signature}&key_id=${KEY_ID}`;
};

let me;
const api = (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${me.token}`);
const nonceFor = async (purpose = 'credits') =>
  (await api('post', '/ads/nonce').send({ purpose })).body.data.nonce;

before(async () => {
  await connectTestDeps();
  ads.__setKeyFetcherForTests(async () => new Map([[KEY_ID, pem]]));
});

beforeEach(async () => {
  Object.assign(ads.settings, {
    ssvEnabled: true,
    adUnitIds: [],
    dailyLimit: 20,
    rewardCredits: 500,
  });
  const user = await createUniqueUser({ email: 'ad@t.io', name: 'Viewer', gender: 'female' });
  me = { user, uid: String(user._id), token: signAccessToken(user._id) };
});

afterEach(resetTestDeps);
after(closeTestDeps);

describe('SSV callback (28.9 - 28.11)', () => {
  it('a valid Google callback pays once per transaction', async () => {
    const nonce = await nonceFor();
    const q = ssvQuery({ userId: me.uid, nonce, tx: 'tx-1' });
    const res = await request(app).get(`/api/v1/ads/ssv?${q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.granted, true);
    assert.equal((await User.findById(me.uid).lean()).credits, 500);
    const t = await CreditTransaction.findOne({ refId: 'ad:tx-1' }).lean();
    assert.equal(t.type, 'ad_reward');
    assert.equal(t.meta.source, 'ssv');

    // Google retries the same callback: no second payment
    const again = await request(app).get(`/api/v1/ads/ssv?${q}`);
    assert.equal(again.status, 200);
    assert.equal(again.body.granted, false);
    assert.equal((await User.findById(me.uid).lean()).credits, 500);
  });

  it('rejects a bad / tampered signature and unknown keys', async () => {
    const nonce = await nonceFor();
    const tampered = ssvQuery({ userId: me.uid, nonce, tx: 'tx-2', tamper: true });
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${tampered}`)).status, 403);
    const noSig = `user_id=${me.uid}&custom_data=${nonce}`;
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${noSig}`)).status, 403);
    const wrongKey = ssvQuery({ userId: me.uid, nonce, tx: 'tx-3' }).replace(KEY_ID, '1');
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${wrongKey}`)).status, 403);
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });

  it("someone else's nonce or a made-up one pays nothing", async () => {
    const other = await createUniqueUser({ email: 'o@t.io', name: 'Other', gender: 'male' });
    const nonce = await nonceFor();
    const q = ssvQuery({ userId: String(other._id), nonce, tx: 'tx-4' });
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${q}`)).body.granted, false);
    const fake = ssvQuery({ userId: me.uid, nonce: 'f'.repeat(32), tx: 'tx-5' });
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${fake}`)).body.granted, false);
  });

  it('only configured ad units count', async () => {
    ads.settings.adUnitIds = ['ca-app-pub-123/1111111111'];
    const nonce = await nonceFor();
    const q = ssvQuery({ userId: me.uid, nonce, tx: 'tx-6', adUnit: '2222222222' });
    const res = await request(app).get(`/api/v1/ads/ssv?${q}`);
    assert.equal(res.body.ignored, 'UNKNOWN_AD_UNIT');
    const ok = ssvQuery({ userId: me.uid, nonce, tx: 'tx-7', adUnit: '1111111111' });
    assert.equal((await request(app).get(`/api/v1/ads/ssv?${ok}`)).body.granted, true);
  });

  it('spin ads give an extra spin instead of credits', async () => {
    const nonce = await nonceFor('spin');
    await request(app).get(`/api/v1/ads/ssv?${ssvQuery({ userId: me.uid, nonce, tx: 'tx-8' })}`);
    assert.equal(await ads.extraSpinsToday(me.uid), 1);
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });
});

describe('daily limit and dev claim (28.13)', () => {
  it('stops at DAILY_AD_LIMIT; GET /wallet shows the count', async () => {
    ads.settings.dailyLimit = 2;
    for (let i = 0; i < 2; i += 1) {
      const nonce = await nonceFor();
      await request(app).get(`/api/v1/ads/ssv?${ssvQuery({ userId: me.uid, nonce, tx: `l${i}` })}`);
    }
    const limited = await api('post', '/ads/nonce').send({ purpose: 'credits' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'DAILY_LIMIT');
    const w = (await api('get', '/wallet')).body.data;
    assert.equal(w.balance, 1000);
    assert.equal(w.ads.today, 2);
  });

  it('with SSV on, the app claim just says "pending"', async () => {
    const nonce = await nonceFor();
    const res = await api('post', '/ads/claim').send({ nonce });
    assert.deepEqual(res.body.data, { pending: true });
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
  });

  it('with SSV off (dev), the app claim pays once per nonce', async () => {
    ads.settings.ssvEnabled = false;
    const { body } = await api('post', '/ads/nonce').send({ purpose: 'credits' });
    assert.equal(body.data.ssv, false);
    const first = await api('post', '/ads/claim').send({ nonce: body.data.nonce });
    assert.equal(first.body.data.granted, true);
    assert.equal(first.body.data.balance, 500);
    const again = await api('post', '/ads/claim').send({ nonce: body.data.nonce });
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'NONCE_INVALID');
  });

  it('validates input', async () => {
    assert.equal((await api('post', '/ads/nonce').send({ purpose: 'free-money' })).status, 400);
    assert.equal((await api('post', '/ads/claim').send({ nonce: 'x' })).status, 400);
    assert.equal((await request(app).post('/api/v1/ads/nonce').send({})).status, 401);
  });
});
