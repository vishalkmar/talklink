// Phase 31: Cashfree payments - orders, verify, webhook signature, idempotent granting, premium.
process.env.CASHFREE_APP_ID = 'TEST_APP_ID';
process.env.CASHFREE_SECRET_KEY = 'test_secret_key_for_cashfree';
process.env.CASHFREE_NOTIFY_URL = 'https://api.example.com/api/v1/payments/webhook';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { CreditTransaction, Payment, User } = require('../src/models');
const cashfree = require('../src/services/cashfree.service');
const payments = require('../src/services/payment.service');
const spin = require('../src/services/spin.service');

// fake Cashfree: orders live here; tests set their status
let orders;
let calls;
const fakeCashfree = async (method, path, body) => {
  calls.push([method, path, body]);
  if (method === 'POST' && path === '/orders') {
    orders.set(body.order_id, { status: 'ACTIVE', payments: [] });
    return {
      status: 200,
      data: {
        cf_order_id: 987654,
        order_id: body.order_id,
        payment_session_id: `session_${body.order_id}`,
        order_status: 'ACTIVE',
      },
    };
  }
  const m = path.match(/^\/orders\/([^/]+)(\/payments)?$/);
  const o = m && orders.get(decodeURIComponent(m[1]));
  if (!o) return { status: 404, data: { message: 'order not found' } };
  if (m[2]) return { status: 200, data: o.payments };
  return { status: 200, data: { order_id: m[1], order_status: o.status } };
};

const sign = (raw, ts) =>
  crypto
    .createHmac('sha256', 'test_secret_key_for_cashfree')
    .update(`${ts}${raw}`)
    .digest('base64');
const webhook = (orderId, { badSig = false } = {}) => {
  const raw = JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: { order: { order_id: orderId }, payment: { payment_status: 'SUCCESS' } },
  });
  const ts = String(Date.now());
  return request(app)
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-webhook-timestamp', ts)
    .set('x-webhook-signature', badSig ? 'nope' : sign(raw, ts))
    .send(raw);
};

let me;
const api = (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${me.token}`);
const order = async (planId, phone = '9876543210') =>
  (await api('post', '/payments/create-order').send({ planId, phone })).body.data;
const pay = (orderId) => {
  orders.get(orderId).status = 'PAID';
  orders.get(orderId).payments = [
    { payment_status: 'SUCCESS', payment_time: new Date().toISOString() },
  ];
};

before(async () => {
  await connectTestDeps();
  cashfree.__setTransportForTests(fakeCashfree);
});

beforeEach(async () => {
  orders = new Map();
  calls = [];
  const user = await createUniqueUser({ email: 'buyer@t.io', name: 'Buyer', gender: 'female' });
  me = { user, uid: String(user._id), token: signAccessToken(user._id) };
});

afterEach(resetTestDeps);
after(closeTestDeps);

describe('plans and orders (31.3, 31.5, 31.6)', () => {
  it('lists plans with prices from .env', async () => {
    const res = await api('get', '/payments/plans');
    const ids = res.body.data.plans.map((p) => p.id);
    assert.deepEqual(ids, [
      'premium_weekly',
      'premium_monthly',
      'premium_yearly',
      'credits_5000',
      'credits_12000',
      'credits_30000',
    ]);
    assert.equal(res.body.data.plans[1].price, 149);
    assert.equal(res.body.data.available, true);
    assert.ok(res.body.data.benefits.length >= 5);
  });

  it('creates a Cashfree order and a Payment, returns the session id', async () => {
    const res = await api('post', '/payments/create-order').send({
      planId: 'premium_monthly',
      phone: '9876543210',
    });
    assert.equal(res.status, 201);
    const d = res.body.data;
    assert.match(d.orderId, /^TL_\d+_[0-9a-f]{8}$/);
    assert.equal(d.paymentSessionId, `session_${d.orderId}`);
    assert.equal(d.environment, 'SANDBOX');
    assert.equal(d.amount, 149);
    const [, , body] = calls[0];
    assert.equal(body.order_amount, 149);
    assert.equal(body.order_currency, 'INR');
    assert.deepEqual(
      {
        id: body.customer_details.customer_id,
        phone: body.customer_details.customer_phone,
        email: body.customer_details.customer_email,
      },
      { id: me.uid, phone: '9876543210', email: 'buyer@t.io' },
    );
    assert.equal(body.order_meta.notify_url, process.env.CASHFREE_NOTIFY_URL);
    const p = await Payment.findOne({ orderId: d.orderId }).lean();
    assert.equal(p.status, 'created');
    assert.equal(p.cfOrderId, '987654');
    // the phone is remembered for next time (never shown publicly)
    assert.equal((await User.findById(me.uid).lean()).billingPhone, '9876543210');
    const again = await api('post', '/payments/create-order').send({ planId: 'credits_5000' });
    assert.equal(again.status, 201);
    assert.equal((await api('get', '/users/me')).body.data.user.hasBillingPhone, true);
  });

  it('validates plan and phone', async () => {
    assert.equal(
      (
        await api('post', '/payments/create-order').send({
          planId: 'free_money',
          phone: '9876543210',
        })
      ).body.code,
      'UNKNOWN_PLAN',
    );
    assert.equal(
      (await api('post', '/payments/create-order').send({ planId: 'premium_weekly' })).body.code,
      'PHONE_REQUIRED',
    );
    assert.equal(
      (
        await api('post', '/payments/create-order').send({
          planId: 'premium_weekly',
          phone: '12345',
        })
      ).status,
      400,
    );
  });
});

describe('verify (31.9, 31.10, 31.16)', () => {
  it('grants premium only when Cashfree says PAID', async () => {
    const o = await order('premium_monthly');
    const pending = await api('get', `/payments/verify/${o.orderId}`);
    assert.deepEqual(
      { s: pending.body.data.status, g: pending.body.data.granted },
      { s: 'pending', g: false },
    );
    assert.equal((await User.findById(me.uid).lean()).isPremium, false);

    pay(o.orderId);
    const paid = (await api('get', `/payments/verify/${o.orderId}`)).body.data;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.granted, true);
    const until = new Date(paid.premiumUntil).getTime();
    assert.ok(Math.abs(until - (Date.now() + 30 * 86400000)) < 10000);
    const u = await User.findById(me.uid).lean();
    assert.equal(u.isPremium, true);
    // premium benefits: badge + free gender filter + more free spins
    assert.equal((await api('get', `/users/${me.uid}/public`)).body.data.user.premium, true);
    const st = (await api('get', '/spin')).body.data;
    assert.equal(st.perDay, spin.settings.perDay + 3);
    assert.equal(st.freeLeft, st.perDay);
  });

  it('buying again extends from the current end date', async () => {
    const a = await order('premium_weekly');
    pay(a.orderId);
    await api('get', `/payments/verify/${a.orderId}`);
    const b = await order('premium_weekly');
    pay(b.orderId);
    const res = (await api('get', `/payments/verify/${b.orderId}`)).body.data;
    assert.ok(
      Math.abs(new Date(res.premiumUntil).getTime() - (Date.now() + 14 * 86400000)) < 10000,
    );
  });

  it('credit packs go to the wallet once', async () => {
    const o = await order('credits_12000');
    pay(o.orderId);
    const res = (await api('get', `/payments/verify/${o.orderId}`)).body.data;
    assert.equal(res.balance, 12000);
    const again = (await api('get', `/payments/verify/${o.orderId}`)).body.data;
    assert.equal(again.alreadyGranted, true);
    assert.equal(await CreditTransaction.countDocuments({ type: 'purchase' }), 1);
  });

  it('failed / cancelled / expired payments are reported, nothing granted', async () => {
    const o = await order('premium_weekly');
    orders.get(o.orderId).payments = [
      { payment_status: 'FAILED', payment_time: new Date().toISOString() },
    ];
    assert.equal((await api('get', `/payments/verify/${o.orderId}`)).body.data.status, 'failed');
    orders.get(o.orderId).payments.push({
      payment_status: 'USER_DROPPED',
      payment_time: new Date(Date.now() + 1000).toISOString(),
    });
    assert.equal((await api('get', `/payments/verify/${o.orderId}`)).body.data.status, 'cancelled');
    orders.get(o.orderId).status = 'EXPIRED';
    assert.equal((await api('get', `/payments/verify/${o.orderId}`)).body.data.status, 'cancelled');
    // a SUCCESS attempt alone is not enough while the order is not PAID
    orders.get(o.orderId).status = 'ACTIVE';
    orders.get(o.orderId).payments = [
      { payment_status: 'SUCCESS', payment_time: new Date().toISOString() },
    ];
    assert.equal((await api('get', `/payments/verify/${o.orderId}`)).body.data.status, 'pending');
    assert.equal((await User.findById(me.uid).lean()).isPremium, false);
  });

  it("someone else's order is not found", async () => {
    const o = await order('premium_weekly');
    const other = await createUniqueUser({ email: 'x@t.io', name: 'Other', gender: 'male' });
    const res = await request(app)
      .get(`/api/v1/payments/verify/${o.orderId}`)
      .set('Authorization', `Bearer ${signAccessToken(other._id)}`);
    assert.equal(res.status, 404);
  });
});

describe('webhook (31.11 - 31.13)', () => {
  it('a signed webhook grants; the app verify afterwards does not grant twice', async () => {
    const o = await order('credits_5000');
    pay(o.orderId);
    const res = await webhook(o.orderId);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'paid');
    await api('get', `/payments/verify/${o.orderId}`);
    assert.equal((await User.findById(me.uid).lean()).credits, 5000);
    const p = await Payment.findOne({ orderId: o.orderId }).lean();
    assert.equal(p.rawWebhook.type, 'PAYMENT_SUCCESS_WEBHOOK');
  });

  it('webhook and verify at the same moment grant premium exactly once', async () => {
    const o = await order('premium_weekly');
    pay(o.orderId);
    await Promise.all([
      webhook(o.orderId),
      api('get', `/payments/verify/${o.orderId}`),
      webhook(o.orderId),
    ]);
    const u = await User.findById(me.uid).lean();
    assert.ok(Math.abs(u.premiumUntil.getTime() - (Date.now() + 7 * 86400000)) < 10000);
  });

  it('rejects a bad signature; unknown orders are ignored', async () => {
    const o = await order('credits_5000');
    pay(o.orderId);
    assert.equal((await webhook(o.orderId, { badSig: true })).status, 401);
    assert.equal((await User.findById(me.uid).lean()).credits, 0);
    assert.equal((await webhook('TL_nope')).body.data.ignored, 'UNKNOWN_ORDER');
  });
});

describe('history and expiry (31.17, 31.18)', () => {
  it('lists my payments; expired premium is switched off by the job', async () => {
    const o = await order('premium_weekly');
    pay(o.orderId);
    await api('get', `/payments/verify/${o.orderId}`);
    const list = (await api('get', '/payments')).body.data.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'paid');
    assert.equal(list[0].plan, 'premium_weekly');

    await User.updateOne({ _id: me.uid }, { premiumUntil: new Date(Date.now() - 1000) });
    assert.deepEqual(await payments.expirePremium(), { expired: 1 });
    assert.equal((await User.findById(me.uid).lean()).isPremium, false);
  });

  it('without Cashfree keys payments answer 503', async () => {
    const saved = cashfree.settings.appId;
    cashfree.settings.appId = '';
    const res = await api('post', '/payments/create-order').send({
      planId: 'premium_weekly',
      phone: '9876543210',
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'PAYMENTS_UNAVAILABLE');
    cashfree.settings.appId = saved;
  });
});
