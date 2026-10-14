// Invite friends (Phase 33.8). Every user gets a short code (made the first time it is asked
// for). A new account (younger than REFERRAL_WINDOW_DAYS) can enter one code once; then the new
// user and the inviter each get REFERRAL_BONUS_CREDITS (wallet type 'referral', idempotent
// refIds). Abuse limits: not your own code, no A<->B loops, REFERRAL_MAX_PER_DAY paid invites
// per inviter (the new user is still paid).
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const { store } = require('../config/store');
const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { istDayKey } = require('../utils/istDay');

const settings = { ...config.referral };

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const DAY_MS = 24 * 3600 * 1000;

const wallet = () => require('./wallet.service'); // lazy: wallet -> sockets cycle

const randomCode = () =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

const normalizeCode = (code) =>
  String(code || '')
    .trim()
    .toUpperCase();

const inviteLink = (code) => {
  if (settings.inviteUrl) return settings.inviteUrl.replace('{code}', code);
  const referrer = encodeURIComponent(`utm_source=invite&utm_content=${code}`);
  return `https://play.google.com/store/apps/details?id=${config.androidPackage}&referrer=${referrer}`;
};

const ensureCode = async (userId) => {
  const user = await User.findById(userId).select('referralCode').lean();
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 5; i += 1) {
    const code = randomCode();
    try {
      const res = await User.findOneAndUpdate(
        { _id: userId, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { returnDocument: 'after' },
      ).lean();
      // null: another request set it first
      if (res) return res.referralCode;
      return (await User.findById(userId).select('referralCode').lean()).referralCode;
    } catch (err) {
      if (err.code !== 11000) throw err; // taken by someone else: try another
    }
  }
  throw ApiError.internal('Could not create an invite code', 'REFERRAL_CODE_FAILED');
};

const canEnterCode = (user, now = new Date()) =>
  !user.referredBy && now - new Date(user.createdAt) <= settings.windowDays * DAY_MS;

// GET /referrals/me
const getMine = async (userId) => {
  const code = await ensureCode(userId);
  const [user, invited, earned] = await Promise.all([
    User.findById(userId).select('referredBy createdAt').lean(),
    User.countDocuments({ referredBy: userId }),
    CreditTransaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(String(userId)), type: 'referral' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  return {
    code,
    link: inviteLink(code),
    bonus: settings.bonusCredits,
    invited,
    earned: (earned[0] && earned[0].total) || 0,
    canEnterCode: canEnterCode(user),
    windowDays: settings.windowDays,
  };
};

// POST /referrals/apply { code }
const applyCode = async (userId, rawCode) => {
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code))
    throw ApiError.badRequest('This invite code is not valid', 'INVALID_CODE');
  const user = await User.findById(userId).select('referredBy createdAt referralCode').lean();
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.referredBy)
    throw ApiError.conflict('You already used an invite code', 'ALREADY_REFERRED');
  if (!canEnterCode(user)) {
    throw ApiError.forbidden(
      `Invite codes can be used in the first ${settings.windowDays} days only`,
      'REFERRAL_WINDOW_OVER',
    );
  }
  if (user.referralCode === code) {
    throw ApiError.badRequest("You can't use your own invite code", 'OWN_CODE');
  }
  const inviter = await User.findOne({ referralCode: code, status: 'active' })
    .select('_id referredBy')
    .lean();
  if (!inviter) throw ApiError.badRequest('This invite code is not valid', 'INVALID_CODE');
  if (inviter.referredBy && inviter.referredBy.equals(userId)) {
    throw ApiError.badRequest('You invited this person yourself', 'REFERRAL_LOOP');
  }

  // once per user, even with two requests at the same time
  const now = new Date();
  const set = await User.updateOne(
    { _id: userId, referredBy: { $exists: false } },
    { $set: { referredBy: inviter._id, referredAt: now } },
  );
  if (!set.modifiedCount) {
    throw ApiError.conflict('You already used an invite code', 'ALREADY_REFERRED');
  }

  const bonus = settings.bonusCredits;
  let balance;
  let inviterRewarded = false;
  if (bonus > 0) {
    const mine = await wallet().credit({
      userId,
      amount: bonus,
      type: 'referral',
      refId: `referral:${userId}:joined`,
      meta: { inviterId: String(inviter._id) },
    });
    balance = mine.balance;
    const dayKey = `referral:paid:${inviter._id}:${istDayKey(now)}`;
    const paidToday = await store.incr(dayKey);
    if (paidToday === 1) await store.expire(dayKey, 2 * 24 * 3600);
    if (paidToday <= settings.maxPerDay) {
      await wallet().credit({
        userId: inviter._id,
        amount: bonus,
        type: 'referral',
        refId: `referral:${userId}:inviter`,
        meta: { invitedId: String(userId) },
      });
      inviterRewarded = true;
    } else {
      logger.warn({ inviterId: String(inviter._id) }, 'Referral daily limit reached');
    }
  }
  return { applied: true, bonus, balance, inviterRewarded };
};

module.exports = { settings, getMine, applyCode, ensureCode, inviteLink, normalizeCode, CODE_RE };
