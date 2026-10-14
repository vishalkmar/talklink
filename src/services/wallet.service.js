// Credits wallet (Phase 11 credit core, Phase 27 full wallet). Single source of truth for credits
// earned (signup, daily bonus, ads, spin, goals, referral, admin) and spent (gender filter).
//
//  - Balance (User.credits) and ledger (CreditTransaction) change together in one MongoDB
//    transaction (27.3).
//  - Every operation is idempotent by refId (unique index, 27.5): a retry returns the first result.
//  - Debits are a conditional $inc (credits >= amount) so two requests at once can never overspend
//    (27.4 / 27.17).
//  - After a change the user's devices get wallet:updated (27.12).
//  - Too many earn events in 10 minutes flags the account for review (27.16).
const mongoose = require('mongoose');
const config = require('../config');
const { store } = require('../config/store');
const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { isDuplicateKey } = require('../utils/privateNumber');
const { istDayKey, istNextDayStart } = require('../utils/istDay');
const { SPINS_PER_DAY } = require('../constants/appConfig');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

const EARN_TYPES = ['daily_bonus', 'ad_reward', 'spin', 'goal', 'referral'];
const ABUSE_WINDOW_MS = 10 * 60 * 1000;
const PAGE_SIZE = 30;

const settings = { abuseLimit: config.economy.rewardAbuseLimit };

const notify = (userId, payload) => {
  try {
    emitter.emitToUser(String(userId), EVENTS.WALLET_UPDATED, payload);
  } catch (err) {
    logger.warn({ err: err.message }, 'wallet:updated emit failed');
  }
};

// 27.16 a burst of rewards (bots / modded app) -> flag for review, rewards keep working
const checkAbuse = async (userId, type) => {
  if (!EARN_TYPES.includes(type)) return;
  const since = new Date(Date.now() - ABUSE_WINDOW_MS);
  const n = await CreditTransaction.countDocuments({
    userId,
    type: { $in: EARN_TYPES },
    createdAt: { $gte: since },
  });
  if (n > settings.abuseLimit) {
    const res = await User.updateOne(
      { _id: userId, flaggedAt: { $exists: false } },
      { $set: { flaggedAt: new Date(), flagReason: `reward burst: ${n} in 10 min` } },
    );
    if (res.modifiedCount) logger.warn({ userId: String(userId), n }, 'Reward abuse flagged');
  }
};

// amount > 0 credit, < 0 debit. Returns { applied, balance, transaction }.
const apply = async ({ userId, amount, type, refId, meta }) => {
  if (!Number.isInteger(amount) || amount === 0) {
    throw ApiError.badRequest('Amount must be a non-zero integer', 'INVALID_AMOUNT');
  }
  if (!refId) throw ApiError.badRequest('refId is required', 'INVALID_REF');
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const existing = await CreditTransaction.findOne({ refId }).session(session);
      if (existing) {
        result = { applied: false, balance: existing.balanceAfter, transaction: existing };
        return;
      }
      const filter = { _id: userId };
      if (amount < 0) filter.credits = { $gte: -amount }; // never below zero
      const user = await User.findOneAndUpdate(
        filter,
        { $inc: { credits: amount } },
        { returnDocument: 'after', session },
      );
      if (!user) {
        if (amount < 0 && (await User.exists({ _id: userId }).session(session))) {
          throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits');
        }
        throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
      }
      const [tx] = await CreditTransaction.create(
        [{ userId, amount, type, refId, balanceAfter: user.credits, meta }],
        { session },
      );
      result = { applied: true, balance: user.credits, transaction: tx };
    });
  } catch (err) {
    // two requests with the same refId at once: the loser hits the unique index
    if (isDuplicateKey(err, 'refId')) {
      const tx = await CreditTransaction.findOne({ refId });
      return { applied: false, balance: tx ? tx.balanceAfter : undefined, transaction: tx };
    }
    throw err;
  } finally {
    await session.endSession();
  }
  if (result.applied) {
    notify(userId, { balance: result.balance, change: amount, type });
    checkAbuse(userId, type).catch((err) => logger.error({ err }, 'abuse check failed'));
  }
  return result;
};

// 27.2
const credit = async ({ userId, amount, type, refId, meta }) => {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.badRequest('Credit amount must be a positive integer', 'INVALID_AMOUNT');
  }
  return apply({ userId, amount, type, refId, meta });
};

const debit = async ({ userId, amount, type, refId, meta }) => {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.badRequest('Debit amount must be a positive integer', 'INVALID_AMOUNT');
  }
  return apply({ userId, amount: -amount, type, refId, meta });
};

const signupBonusRef = (userId) => `signup_bonus:${userId}`;
const dailyBonusRef = (userId, day = istDayKey()) => `daily_bonus:${userId}:${day}`;

// 27.14 once per IST day
const claimDailyBonus = async (userId) => {
  const amount = config.economy.dailyBonusCredits;
  if (!amount) return { applied: false, amount: 0 };
  const res = await credit({ userId, amount, type: 'daily_bonus', refId: dailyBonusRef(userId) });
  return { applied: res.applied, amount, balance: res.balance };
};

// 27.6 balance + today's limits (resets at IST midnight)
const getWallet = async (userId) => {
  const [user, adsToday, spinsToday, bonus] = await Promise.all([
    User.findById(userId).select('credits isPremium premiumUntil').lean(),
    // every rewarded ad today (credits + spin ads), counted by ads.service (Phase 28)
    store.get(`ad:count:${userId}:${istDayKey()}`).then((n) => Number(n) || 0),
    // spins used today, counted by spin.service (Phase 29)
    store.get(`spin:count:${userId}:${istDayKey()}`).then((n) => Number(n) || 0),
    CreditTransaction.exists({ refId: dailyBonusRef(userId) }),
  ]);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  const { dailyAdLimit, adRewardCredits, genderFilterCost, dailyBonusCredits } = config.economy;
  const premium = Boolean(
    user.isPremium && (!user.premiumUntil || new Date(user.premiumUntil) > new Date()),
  );
  const spinLimit = SPINS_PER_DAY + (premium ? config.plans.premiumExtraSpins : 0);
  return {
    balance: user.credits,
    genderFilterCost,
    ads: {
      today: adsToday,
      limit: dailyAdLimit,
      left: Math.max(0, dailyAdLimit - adsToday),
      reward: adRewardCredits,
    },
    spins: {
      today: spinsToday,
      limit: spinLimit,
      left: Math.max(0, spinLimit - spinsToday),
    },
    dailyBonus: { amount: dailyBonusCredits, claimed: Boolean(bonus) },
    resetsAt: istNextDayStart(),
  };
};

const toTx = (t) => ({
  id: String(t._id),
  amount: t.amount,
  type: t.type,
  balanceAfter: t.balanceAfter,
  createdAt: t.createdAt,
  meta: t.meta || null,
});

// 27.7 newest first; cursor = id of the last item of the previous page
const listTransactions = async (userId, { cursor, limit = PAGE_SIZE } = {}) => {
  const filter = { userId };
  if (cursor) {
    if (!mongoose.isValidObjectId(cursor)) {
      throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const pivot = await CreditTransaction.findOne({ _id: cursor, userId })
      .select('createdAt')
      .lean();
    if (!pivot) throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
    filter.$or = [
      { createdAt: { $lt: pivot.createdAt } },
      { createdAt: pivot.createdAt, _id: { $lt: pivot._id } },
    ];
  }
  const rows = await CreditTransaction.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { items: page.map(toTx), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
};

module.exports = {
  settings,
  EARN_TYPES,
  credit,
  debit,
  claimDailyBonus,
  getWallet,
  listTransactions,
  signupBonusRef,
  dailyBonusRef,
  toTx,
};
