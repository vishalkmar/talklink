const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const mailService = require('../src/services/mail.service');
const otpService = require('../src/services/otp.service');
const tokenService = require('../src/services/token.service');
const ApiError = require('../src/utils/ApiError');
const { store } = require('../src/config/store');
const { Otp, User, Session } = require('../src/models');

const EMAIL = 'Rahul.Test@Example.com';
const NORM = 'rahul.test@example.com';

let sentOtps;
const lastOtp = () => sentOtps[sentOtps.length - 1].otp;

const sendOtp = (email = EMAIL) => request(app).post('/api/v1/auth/send-otp').send({ email });
const verify = (otp, email = EMAIL) =>
  request(app)
    .post('/api/v1/auth/verify-otp')
    .send({ email, otp, device: { platform: 'android', model: 'Pixel 8', appVersion: '1.0.0' } });
const login = async (email = EMAIL) => {
  await sendOtp(email);
  return verify(lastOtp(), email);
};

before(connectTestDeps);
after(closeTestDeps);
beforeEach(() => {
  sentOtps = [];
  mock.method(mailService, 'sendOtpEmail', async (email, otp) => {
    sentOtps.push({ email, otp });
    return { messageId: 'test' };
  });
});
afterEach(async () => {
  mock.restoreAll();
  await resetTestDeps();
});

describe('POST /auth/send-otp', () => {
  it('rejects an invalid email', async () => {
    const res = await sendOtp('not-an-email');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  });

  it('normalises the email, emails a 6-digit code and stores only its hash', async () => {
    const res = await sendOtp();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { email: NORM, expiresInSec: 300, resendInSec: 60 });
    assert.equal(sentOtps.length, 1);
    assert.equal(sentOtps[0].email, NORM);
    assert.match(lastOtp(), /^\d{6}$/);

    const doc = await Otp.findOne({ email: NORM }).lean();
    assert.ok(doc);
    assert.notEqual(doc.otpHash, lastOtp());
    assert.ok(!JSON.stringify(doc).includes(lastOtp()));
  });

  it('enforces a 60s resend cooldown', async () => {
    await sendOtp();
    const res = await sendOtp();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'OTP_COOLDOWN');
    assert.ok(res.body.details.retryAfterSec > 0);
  });

  it('allows at most 5 codes per hour', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await sendOtp()).status, 200);
      await store.del(otpService.keys.cooldown(NORM)); // skip the 60s wait
    }
    const res = await sendOtp();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'OTP_HOURLY_LIMIT');
  });

  it('returns 502 and releases the quota when Brevo fails', async () => {
    mailService.sendOtpEmail.mock.mockImplementation(async () => {
      throw new ApiError(502, 'EMAIL_SEND_FAILED', 'fail');
    });
    const res = await sendOtp();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'EMAIL_SEND_FAILED');
    assert.equal(await Otp.countDocuments({ email: NORM }), 0);
    assert.equal(await store.exists(otpService.keys.cooldown(NORM)), 0);
  });
});

describe('POST /auth/verify-otp', () => {
  it('logs in a new user with tokens and a private number', async () => {
    await sendOtp();
    const res = await verify(lastOtp());
    assert.equal(res.status, 200);
    const { user, isNewUser, tokens } = res.body.data;
    assert.equal(isNewUser, true);
    assert.equal(user.email, NORM);
    assert.match(user.privateNumber, /^\d{5,6}$/);
    assert.equal(user.isProfileComplete, false);
    assert.equal(tokens.accessTokenExpiresIn, 900);
    assert.equal(tokens.refreshTokenExpiresIn, 30 * 86400);
    assert.equal(tokenService.verifyAccessToken(tokens.accessToken).sub, user.id);

    assert.equal(await Otp.countDocuments({ email: NORM }), 0, 'OTP is single-use');
    const session = await Session.findOne({ userId: user.id }).lean();
    assert.equal(session.tokenHash, tokenService.hashToken(tokens.refreshToken));
    assert.equal(session.device.model, 'Pixel 8');
  });

  it('returns the same user with isNewUser=false on the next login', async () => {
    const first = await login();
    await store.del(otpService.keys.cooldown(NORM));
    const second = await login();
    assert.equal(second.body.data.isNewUser, false);
    assert.equal(second.body.data.user.id, first.body.data.user.id);
    assert.equal(await User.countDocuments(), 1);
  });

  it('rejects a wrong code and reports attempts left', async () => {
    await sendOtp();
    const wrong = lastOtp() === '111111' ? '222222' : '111111';
    const res = await verify(wrong);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'OTP_INVALID');
    assert.equal(res.body.details.attemptsLeft, 4);
  });

  it('locks the email for 15 minutes after 5 wrong codes', async () => {
    await sendOtp();
    const wrong = lastOtp() === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i += 1) assert.equal((await verify(wrong)).status, 400);
    const fifth = await verify(wrong);
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.code, 'OTP_LOCKED');

    const ttl = await store.ttl(otpService.keys.lock(NORM));
    assert.ok(ttl > 890 && ttl <= 900);
    assert.equal((await verify(lastOtp())).body.code, 'OTP_LOCKED');
    await store.del(otpService.keys.cooldown(NORM));
    assert.equal((await sendOtp()).body.code, 'OTP_LOCKED');
  });

  it('rejects an expired code', async () => {
    await sendOtp();
    await Otp.updateOne({ email: NORM }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await verify(lastOtp());
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'OTP_EXPIRED');
  });

  it('rejects a code that was never requested', async () => {
    const res = await verify('123456');
    assert.equal(res.body.code, 'OTP_EXPIRED');
  });

  it('does not accept the dev bypass code when DEV_OTP_BYPASS is off', async () => {
    await sendOtp();
    if (lastOtp() === '000000') return; // 1-in-a-million real code
    assert.equal((await verify('000000')).body.code, 'OTP_INVALID');
  });

  it('blocks suspended accounts', async () => {
    const res = await login();
    await User.updateOne({ _id: res.body.data.user.id }, { status: 'suspended' });
    await store.del(otpService.keys.cooldown(NORM));
    const again = await login();
    assert.equal(again.status, 403);
    assert.equal(again.body.code, 'ACCOUNT_SUSPENDED');
  });
});

describe('POST /auth/refresh and /auth/logout', () => {
  const refresh = (refreshToken) =>
    request(app).post('/api/v1/auth/refresh').send({ refreshToken });

  it('rotates the refresh token', async () => {
    const { tokens } = (await login()).body.data;
    const res = await refresh(tokens.refreshToken);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.data.tokens.refreshToken, tokens.refreshToken);
    assert.ok(res.body.data.tokens.accessToken);
    assert.equal(res.body.data.user.email, NORM);
  });

  it('detects reuse of a rotated token and revokes the whole login', async () => {
    const { tokens } = (await login()).body.data;
    const next = (await refresh(tokens.refreshToken)).body.data.tokens;

    const reuse = await refresh(tokens.refreshToken);
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.code, 'REFRESH_TOKEN_REUSED');

    const afterTheft = await refresh(next.refreshToken);
    assert.equal(afterTheft.status, 401, 'the newer token is revoked too');
  });

  it('rejects unknown and expired refresh tokens', async () => {
    assert.equal((await refresh('x'.repeat(64))).body.code, 'INVALID_REFRESH_TOKEN');

    const { tokens } = (await login()).body.data;
    await Session.updateOne(
      { tokenHash: tokenService.hashToken(tokens.refreshToken) },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    assert.equal((await refresh(tokens.refreshToken)).body.code, 'REFRESH_TOKEN_EXPIRED');
  });

  it('logout revokes the session', async () => {
    const { tokens } = (await login()).body.data;
    const out = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: tokens.refreshToken });
    assert.equal(out.status, 200);
    assert.equal((await refresh(tokens.refreshToken)).status, 401);
  });
});
