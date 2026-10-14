// Spin wheel (Phase 29). The server picks the result - the app only animates to it (29.3).
//
// Per IST day: SPINS_PER_DAY spins, the first FREE_SPINS_PER_DAY are free, every other spin
// needs a spin token earned by watching a rewarded ad (purpose 'spin', Phase 28 ads.service).
// A spin = weighted random segment -> wallet credit (type 'spin', refId spin:<uid>:<day>:<n>,
// meta { segmentIndex, credits, free }) -> wallet:updated.
//
// Redis:
//   spin:count:<uid>:<day>   spins used today (reserved with INCR, so parallel taps can't exceed)
//   spin:extra:<uid>:<day>   ad-earned spin tokens (written by ads.service)
const crypto = require('crypto');
const { redis } = require('../config/redis');
const CreditTransaction = require('../models/CreditTransaction');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { istDayKey, istNextDayStart } = require('../utils/istDay');
const { SPIN_SEGMENTS, SPINS_PER_DAY, FREE_SPINS_PER_DAY } = require('../constants/appConfig');
const config = require('../config');
const User = require('../models/User');
const wallet = require('./wallet.service');
const { isPremiumActive } = require('./filter.service');
const ads = require('./ads.service');

const settings = {
  segments: SPIN_SEGMENTS,
  perDay: SPINS_PER_DAY,
  freePerDay: FREE_SPINS_PER_DAY,
  premiumExtra: config.plans.premiumExtraSpins, // 31.4
  random: (max) => crypto.randomInt(max), // tests can make it deterministic
};

const K = {
  count: (uid, day = istDayKey()) => `spin:count:${uid}:${day}`,
  extra: (uid, day = istDayKey()) => ads.keys.extraSpins(uid, day),
};
const TTL_SEC = 2 * 24 * 3600;

// 29.3 weighted pick: P(segment) = weight / sum(weights)
const pickSegment = () => {
  const total = settings.segments.reduce((n, s) => n + s.weight, 0);
  let r = settings.random(total);
  for (let i = 0; i < settings.segments.length; i += 1) {
    if (r < settings.segments[i].weight) return i;
    r -= settings.segments[i].weight;
  }
  return settings.segments.length - 1;
};

// premium: more spins a day and every one of them free (no videos)
const limitsFor = async (uid) => {
  const user = await User.findById(uid).select('isPremium premiumUntil').lean();
  if (isPremiumActive(user)) {
    const perDay = settings.perDay + settings.premiumExtra;
    return { perDay, freePerDay: perDay, premium: true };
  }
  return { perDay: settings.perDay, freePerDay: settings.freePerDay, premium: false };
};

const status = async (userId) => {
  const uid = String(userId);
  const limits = await limitsFor(uid);
  const [used, extra, history] = await Promise.all([
    redis.get(K.count(uid)).then((n) => Number(n) || 0),
    redis.get(K.extra(uid)).then((n) => Number(n) || 0),
    CreditTransaction.find({ userId: uid, type: 'spin' }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  const left = Math.max(0, limits.perDay - used);
  return {
    segments: settings.segments.map((s) => s.credits),
    perDay: limits.perDay,
    premium: limits.premium,
    today: used,
    left,
    freeLeft: Math.max(0, Math.min(left, limits.freePerDay - used)),
    adSpins: Math.min(extra, left), // spins already paid for with a video
    resetsAt: istNextDayStart(),
    history: history.map((t) => ({
      id: String(t._id),
      credits: t.amount,
      segmentIndex: t.meta ? t.meta.segmentIndex : null,
      free: Boolean(t.meta && t.meta.free),
      createdAt: t.createdAt,
    })),
  };
};

// 29.4 / 29.5 / 29.13
const spin = async (userId) => {
  const uid = String(userId);
  const limits = await limitsFor(uid);
  const countKey = K.count(uid);
  const n = await redis.incr(countKey); // reserve this spin's slot first
  if (n === 1) await redis.expire(countKey, TTL_SEC);
  const release = () => redis.decr(countKey);

  if (n > limits.perDay) {
    await release();
    throw new ApiError(429, 'SPIN_LIMIT', 'No spins left today', { resetsAt: istNextDayStart() });
  }
  const free = n <= limits.freePerDay;
  if (!free) {
    // use one ad-earned token; none -> the app shows a video first (29.12: nothing is used up)
    const left = await redis.decr(K.extra(uid));
    if (left < 0) {
      await redis.incr(K.extra(uid));
      await release();
      throw new ApiError(402, 'AD_REQUIRED', 'Watch a short video to spin again');
    }
  }

  const segmentIndex = pickSegment();
  const credits = settings.segments[segmentIndex].credits;
  let result;
  try {
    result = await wallet.credit({
      userId: uid,
      amount: credits,
      type: 'spin',
      refId: `spin:${uid}:${istDayKey()}:${n}`,
      meta: { segmentIndex, credits, free },
    });
  } catch (err) {
    // give the spin (and the token) back if the credit failed
    await release();
    if (!free) await redis.incr(K.extra(uid));
    throw err;
  }
  logger.info({ userId: uid, segmentIndex, credits, free }, 'Spin');
  await require('./gamification.service').bump(uid, 'spins', 1); // 32.8 goal progress
  const after = await status(uid);
  return {
    segmentIndex,
    credits,
    free,
    balance: result.balance,
    left: after.left,
    freeLeft: after.freeLeft,
    adSpins: after.adSpins,
    resetsAt: after.resetsAt,
  };
};

module.exports = { settings, keys: K, pickSegment, status, spin };
