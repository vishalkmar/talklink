// Phase 34.1: outside providers without the network - Brevo (email) and Cashfree (payments)
// clients, the OTP email template. The HTTP layer is faked; no keys are needed.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mail = require('../src/services/mail.service');
const cashfree = require('../src/services/cashfree.service');
const { otpEmail } = require('../src/templates/otpEmail');

describe('Brevo email client', () => {
  const saved = { ...mail.settings };
  beforeEach(() =>
    Object.assign(mail.settings, { apiKey: '', senderEmail: '', senderName: 'TalkLink' }),
  );
  afterEach(() => {
    Object.assign(mail.settings, saved);
    mock.restoreAll();
  });

  it('without keys nothing is sent', async () => {
    const post = mock.method(mail.__client, 'post', async () => ({ data: {} }));
    assert.deepEqual(await mail.sendEmail({ to: 'a@b.io', subject: 's', text: 't' }), {
      skipped: true,
    });
    assert.equal(post.mock.callCount(), 0);
  });

  it('sends with sender, reply-to and the api key header', async () => {
    Object.assign(mail.settings, { apiKey: 'xkeysib-test', senderEmail: 'no-reply@t.io' });
    const post = mock.method(mail.__client, 'post', async () => ({ data: { messageId: '<m1>' } }));
    const res = await mail.sendEmail({
      to: 'a@b.io',
      subject: 'Hi',
      html: '<p>x</p>',
      text: 'x',
      tags: ['feedback'],
      replyTo: 'user@b.io',
    });
    assert.deepEqual(res, { messageId: '<m1>' });
    const [path, body, opts] = post.mock.calls[0].arguments;
    assert.equal(path, '/smtp/email');
    assert.deepEqual(body.sender, { email: 'no-reply@t.io', name: 'TalkLink' });
    assert.deepEqual(body.to, [{ email: 'a@b.io' }]);
    assert.deepEqual(body.replyTo, { email: 'user@b.io' });
    assert.equal(opts.headers['api-key'], 'xkeysib-test');
  });

  it('a Brevo failure becomes 502 EMAIL_SEND_FAILED (no key in the error)', async () => {
    Object.assign(mail.settings, { apiKey: 'xkeysib-test', senderEmail: 'no-reply@t.io' });
    mock.method(mail.__client, 'post', async () => {
      throw Object.assign(new Error('Request failed'), {
        response: { status: 401, data: { code: 'unauthorized', message: 'Key not found' } },
      });
    });
    await assert.rejects(
      mail.sendEmail({ to: 'a@b.io', subject: 's', text: 't' }),
      (err) =>
        err.status === 502 && err.code === 'EMAIL_SEND_FAILED' && !/xkeysib/.test(err.message),
    );
  });

  it('OTP emails: login and delete wording, code escaped', async () => {
    Object.assign(mail.settings, { apiKey: 'k', senderEmail: 's@t.io' });
    const post = mock.method(mail.__client, 'post', async () => ({ data: {} }));
    await mail.sendOtpEmail('a@b.io', '123456');
    await mail.sendOtpEmail('a@b.io', '654321', 'delete');
    const [login, del] = post.mock.calls.map((c) => c.arguments[1]);
    assert.match(login.subject, /login code: 123456$/);
    assert.ok(login.htmlContent.includes('123456'));
    assert.deepEqual(login.tags, ['otp', 'login']);
    assert.match(del.subject, /^Confirm deleting your .* account: 654321$/);
    assert.ok(del.textContent.includes('delete your account'));

    const t = otpEmail({ appName: 'A<b>', otp: '1"2', ttlMinutes: 10 });
    assert.ok(t.html.includes('A&lt;b&gt;'));
    assert.ok(t.html.includes('1&quot;2'));
    assert.ok(!t.html.includes('A<b>'));
  });
});

describe('Cashfree client', () => {
  const saved = { ...cashfree.settings };
  let realFetch;
  beforeEach(() => {
    realFetch = global.fetch;
    Object.assign(cashfree.settings, {
      appId: 'TEST_APP',
      secretKey: 'cfsk_test',
      webhookSecret: '',
      env: 'sandbox',
      apiVersion: '2023-08-01',
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
    Object.assign(cashfree.settings, saved);
  });

  const fakeFetch = (status, data) => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return { status, json: async () => data };
    };
    return calls;
  };

  it('sends the keys as headers to the right environment', async () => {
    const calls = fakeFetch(200, { order_id: 'o1', payment_session_id: 'sess' });
    const res = await cashfree.createOrder({ order_id: 'o1', order_amount: 99 });
    assert.equal(res.payment_session_id, 'sess');
    assert.equal(calls[0].url, 'https://sandbox.cashfree.com/pg/orders');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-client-id'], 'TEST_APP');
    assert.equal(calls[0].init.headers['x-client-secret'], 'cfsk_test');
    assert.equal(calls[0].init.headers['x-api-version'], '2023-08-01');
    assert.equal(JSON.parse(calls[0].init.body).order_amount, 99);

    cashfree.settings.env = 'production';
    await cashfree.getOrder('a/b');
    assert.equal(calls[1].url, 'https://api.cashfree.com/pg/orders/a%2Fb');
    await cashfree.getPayments('o1');
    assert.equal(calls[2].url, 'https://api.cashfree.com/pg/orders/o1/payments');
  });

  it('Cashfree errors and network failures -> 502; no keys -> 503', async () => {
    fakeFetch(400, { code: 'order_amount_invalid', message: 'order_amount should be > 1' });
    await assert.rejects(
      cashfree.createOrder({}),
      (e) => e.status === 502 && /order_amount/.test(e.message),
    );

    global.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    await assert.rejects(cashfree.getOrder('o1'), (e) => e.code === 'PAYMENT_PROVIDER_ERROR');

    fakeFetch(500, null);
    global.fetch = async () => ({
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });
    await assert.rejects(cashfree.getOrder('o1'), (e) => e.message === 'Payment failed');

    cashfree.settings.secretKey = '';
    await assert.rejects(cashfree.getOrder('o1'), (e) => e.status === 503);
  });

  it('webhook signatures: correct, tampered, missing', () => {
    const body = '{"data":{"order":{"order_id":"o1"}}}';
    const ts = '1700000000';
    const sig = crypto.createHmac('sha256', 'cfsk_test').update(`${ts}${body}`).digest('base64');
    assert.equal(cashfree.verifyWebhookSignature(body, ts, sig), true);
    assert.equal(cashfree.verifyWebhookSignature(`${body} `, ts, sig), false);
    assert.equal(cashfree.verifyWebhookSignature(body, '1700000001', sig), false);
    assert.equal(cashfree.verifyWebhookSignature(body, ts, 'short'), false);
    assert.equal(cashfree.verifyWebhookSignature(body, ts, ''), false);
    cashfree.settings.webhookSecret = 'whsec';
    assert.equal(cashfree.verifyWebhookSignature(body, ts, sig), false); // webhook secret wins
  });
});
