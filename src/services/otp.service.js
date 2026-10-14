// Email OTP: generate, store (hash only), rate-limit, verify with attempt lockout.
const crypto = require('crypto');
const config = require('../config');
const { store } = require('../config/store');
const Otp = require('../models/Otp');
const ApiError = require('../utils/ApiError');
const mailService = require('./mail.service');

const RESEND_COOLDOWN_SEC = 60;
const HOURLY_LIMIT = 5;
const LOCK_SEC = 15 * 60;
const DEV_BYPASS_CODE = '000000';

// purpose 'login' keeps the plain email as the key; other purposes (33.17 'delete') get their
// own record, cooldown and lockout so a login code can never confirm a deletion.
const PURPOSES = ['login', 'delete'];
const keyFor = (email, purpose = 'login') => {
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown OTP purpose ${purpose}`);
  return purpose === 'login' ? email : `${purpose}:${email}`;
};

const keys = {
  cooldown: (email) => `otp:cooldown:${email}`,
  hourly: (email) => `otp:hourly:${email}`,
  lock: (email) => `otp:lock:${email}`,
};

// Keyed hash (HMAC) so a leaked DB can't be brute-forced offline against the 10^6 code space.
const hashOtp = (email, otp) =>
  crypto.createHmac('sha256', config.jwt.refreshSecret).update(`${email}:${otp}`).digest('hex');

const safeEqual = (a, b) => {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

const generateOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const assertNotLocked = async (email) => {
  const ttl = await store.ttl(keys.lock(email));
  if (ttl > 0) {
    throw ApiError.tooMany('Too many wrong codes. Try again later.', 'OTP_LOCKED', {
      retryAfterSec: ttl,
    });
  }
};

const sendOtp = async (to, { purpose = 'login' } = {}) => {
  const email = keyFor(to, purpose);
  await assertNotLocked(email);

  const cooldownSet = await store.set(keys.cooldown(email), '1', 'EX', RESEND_COOLDOWN_SEC, 'NX');
  if (!cooldownSet) {
    const ttl = await store.ttl(keys.cooldown(email));
    throw ApiError.tooMany('Please wait before requesting a new code', 'OTP_COOLDOWN', {
      retryAfterSec: Math.max(ttl, 1),
    });
  }

  const sentThisHour = await store.incr(keys.hourly(email));
  if (sentThisHour === 1) await store.expire(keys.hourly(email), 3600);
  if (sentThisHour > HOURLY_LIMIT) {
    const ttl = await store.ttl(keys.hourly(email));
    throw ApiError.tooMany('Too many codes requested. Try again later.', 'OTP_HOURLY_LIMIT', {
      retryAfterSec: Math.max(ttl, 1),
    });
  }

  const otp = generateOtp();
  await Otp.findOneAndUpdate(
    { email },
    {
      $set: {
        otpHash: hashOtp(email, otp),
        attempts: 0,
        expiresAt: new Date(Date.now() + config.otp.ttlSeconds * 1000),
      },
    },
    { upsert: true },
  );

  try {
    await mailService.sendOtpEmail(to, otp, purpose);
  } catch (err) {
    // Email didn't go out: don't charge the user's cooldown/hourly quota for it.
    await Promise.all([
      Otp.deleteOne({ email }),
      store.del(keys.cooldown(email)),
      store.decr(keys.hourly(email)),
    ]);
    throw err;
  }

  return { expiresInSec: config.otp.ttlSeconds, resendInSec: RESEND_COOLDOWN_SEC };
};

const verifyOtp = async (to, otp, { purpose = 'login' } = {}) => {
  const email = keyFor(to, purpose);
  await assertNotLocked(email);

  if (config.otp.devBypass && otp === DEV_BYPASS_CODE) {
    await Otp.deleteOne({ email });
    return true;
  }

  const record = await Otp.findOne({ email });
  if (!record || record.expiresAt <= new Date()) {
    throw ApiError.badRequest('Code expired. Request a new one.', 'OTP_EXPIRED');
  }

  if (!safeEqual(record.otpHash, hashOtp(email, otp))) {
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    const attempts = updated ? updated.attempts : config.otp.maxAttempts;
    if (attempts >= config.otp.maxAttempts) {
      await Promise.all([
        store.set(keys.lock(email), '1', 'EX', LOCK_SEC),
        Otp.deleteOne({ _id: record._id }),
      ]);
      throw ApiError.tooMany('Too many wrong codes. Try again later.', 'OTP_LOCKED', {
        retryAfterSec: LOCK_SEC,
      });
    }
    throw ApiError.badRequest('Wrong code', 'OTP_INVALID', {
      attemptsLeft: config.otp.maxAttempts - attempts,
    });
  }

  await Otp.deleteOne({ _id: record._id });
  return true;
};

module.exports = {
  sendOtp,
  verifyOtp,
  generateOtp,
  hashOtp,
  keys,
  RESEND_COOLDOWN_SEC,
  HOURLY_LIMIT,
  LOCK_SEC,
  DEV_BYPASS_CODE,
};
