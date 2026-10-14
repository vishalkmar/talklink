// Gamification (Phase 32): streak, best, aura, goals, badges, leaderboard, streak-saver.
// Rules: docs/DECISIONS.md ADR-037. All days are IST calendar days.
//
//  Streak  - a call / text session of >= STREAK_MIN_SECONDS on a day keeps it: +1 if yesterday
//            was active, else it restarts at 1. Missing a day -> the 00:05 IST job sets it to 0
//            (remembering the old value for the streak-saver). best = max ever.
//  Aura    - call / chat minutes (AURA_PER_MINUTE), 4-5 star ratings received, goal rewards.
//            Every gain also counts for this week's leaderboard.
//  Goals   - progress counters in Redis per IST day / ISO week; claim once (credits + aura).
//
// Redis:
//   goal:<uid>:<period>:<metric>     counters (period = d:<day> | w:<week>)
//   goal:<uid>:<period>:claimed      SET of claimed goal ids
//   aura:week:<week>                 ZSET user -> aura gained this week
//   streaksaver:<uid>:<day>          video watched for the streak-saver (from ads.service)
const mongoose = require('mongoose');
const config = require('../config');
const { redis } = require('../config/redis');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const {
  istDayKey,
  istDayKeyOffset,
  istWeekKey,
  istNextDayStart,
  istNextWeekStart,
} = require('../utils/istDay');
const { DAILY_GOALS, WEEKLY_GOALS, STREAK_BADGES, METRICS } = require('../constants/goals');
const { toPublicUser } = require('../utils/serializers');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

const settings = {
  minSeconds: config.gamification.streakMinSeconds,
  weekBonus: config.gamification.weekBonusCredits,
  saverDays: config.gamification.saverDays,
  auraPerGoodRating: config.gamification.auraPerGoodRating,
  now: () => new Date(), // tests move the clock
};

const TTL_DAY = 3 * 24 * 3600;
const TTL_WEEK = 15 * 24 * 3600;

const K = {
  counter: (uid, period, metric) => `goal:${uid}:${period}:${metric}`,
  claimed: (uid, period) => `goal:${uid}:${period}:claimed`,
  week: (week) => `aura:week:${week}`,
  saver: (uid, day) => `streaksaver:${uid}:${day}`,
};

const periods = (date = settings.now()) => ({
  day: `d:${istDayKey(date)}`,
  week: `w:${istWeekKey(date)}`,
});

const wallet = () => require('./wallet.service'); // lazy: wallet -> sockets -> ... cycles

const notify = (uid, payload) =>
  emitter.emitToUser(String(uid), EVENTS.GAMIFICATION_UPDATED, payload);

// ---------- aura ----------

// The single place aura is added (calls, sessions, ratings, goals) - keeps the weekly board right.
const addAura = async (userIds, amount, reason) => {
  const ids = [].concat(userIds).map(String);
  if (!amount || amount <= 0 || !ids.length) return;
  await User.updateMany({ _id: { $in: ids } }, { $inc: { aura: amount } });
  const week = K.week(istWeekKey(settings.now()));
  const multi = redis.multi();
  ids.forEach((id) => multi.zincrby(week, amount, id));
  multi.expire(week, TTL_WEEK);
  await multi.exec();
  // live totals for the app (profile stats, goals header)
  const users = await User.find({ _id: { $in: ids } })
    .select('aura')
    .lean();
  users.forEach((u) => notify(u._id, { aura: u.aura, auraAdded: amount, reason }));
  logger.debug({ userIds: ids, amount, reason }, 'Aura added');
};

// ---------- progress ----------

const bump = async (uid, metric, by = 1) => {
  if (!METRICS.includes(metric) || by <= 0) return;
  const { day, week } = periods();
  await redis
    .multi()
    .incrby(K.counter(uid, day, metric), by)
    .expire(K.counter(uid, day, metric), TTL_DAY)
    .incrby(K.counter(uid, week, metric), by)
    .expire(K.counter(uid, week, metric), TTL_WEEK)
    .exec();
};

// ---------- streak (32.1 / 32.2 / 32.11 / 32.17) ----------

const reachedBadges = (streak, have = []) =>
  STREAK_BADGES.filter((b) => streak >= b.days && !have.includes(b.id)).map((b) => b.id);

// counts today for the streak once; returns { increased, streak, best }
const markActiveToday = async (uid) => {
  const now = settings.now();
  const today = istDayKey(now);
  const yesterday = istDayKeyOffset(now, -1);
  // atomic: only the first activity of the day moves the streak
  const user = await User.findOneAndUpdate(
    { _id: uid, lastActiveDay: { $ne: today } },
    [
      {
        $set: {
          streak: { $cond: [{ $eq: ['$lastActiveDay', yesterday] }, { $add: ['$streak', 1] }, 1] },
          lastActiveDay: today,
        },
      },
      { $set: { bestStreak: { $max: ['$bestStreak', '$streak'] } } },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
  if (!user) return { increased: false };

  const badges = reachedBadges(user.streak, user.badges || []);
  if (badges.length) {
    await User.updateOne({ _id: uid }, { $addToSet: { badges: { $each: badges } } });
  }
  // 32.11 bonus on every 7th day of a streak
  let bonus = 0;
  if (user.streak % 7 === 0 && settings.weekBonus > 0) {
    const res = await wallet().credit({
      userId: uid,
      amount: settings.weekBonus,
      type: 'goal',
      refId: `streak7:${uid}:${today}`,
      meta: { reason: 'streak_week', streak: user.streak },
    });
    if (res.applied) bonus = settings.weekBonus;
  }
  notify(uid, { streak: user.streak, bestStreak: user.bestStreak, increased: true, badges, bonus });
  return { increased: true, streak: user.streak, best: user.bestStreak, badges, bonus };
};

// Called when a call / text session ends (both participants).
const recordConversation = async (userIds, seconds) => {
  const ids = [].concat(userIds).map(String);
  await Promise.all(
    ids.map(async (uid) => {
      if (seconds > 0) await bump(uid, 'talk_seconds', Math.floor(seconds));
      if (seconds >= settings.minSeconds) {
        await bump(uid, 'connections', 1);
        await markActiveToday(uid);
      }
    }),
  );
};

// 32.3 00:05 IST: everyone who missed yesterday loses the streak (saved for the streak-saver)
const resetMissedStreaks = async () => {
  const now = settings.now();
  const today = istDayKey(now);
  const yesterday = istDayKeyOffset(now, -1);
  const res = await User.updateMany(
    { streak: { $gt: 0 }, lastActiveDay: { $nin: [today, yesterday] } },
    [{ $set: { streakBeforeReset: '$streak', streakResetDay: today, streak: 0 } }],
    { updatePipeline: true },
  );
  return res.modifiedCount ? { reset: res.modifiedCount } : null;
};

// ---------- streak-saver (32.13) ----------

const saverState = (user, now = settings.now()) => {
  const today = istDayKey(now);
  const lost =
    user.streakResetDay === today && (user.streakBeforeReset || 0) > 0 && user.streak <= 1;
  const cooldownEnds = user.streakSaverUsedAt
    ? new Date(new Date(user.streakSaverUsedAt).getTime() + settings.saverDays * 86400000)
    : null;
  const ready = !cooldownEnds || cooldownEnds <= now;
  return {
    available: lost && ready,
    lostStreak: lost ? user.streakBeforeReset : 0,
    nextAt: ready ? null : cooldownEnds,
  };
};

// after the video (ads purpose 'streak' writes the token): yesterday counts again
// 32.13 a watched 'streak' video -> one saver token for today (IST, same clock as the restore)
const grantSaverToken = async (uid) => {
  await redis.set(K.saver(String(uid), istDayKey(settings.now())), '1', 'EX', 2 * 24 * 3600);
};

const useStreakSaver = async (uid) => {
  const now = settings.now();
  const today = istDayKey(now);
  const user = await User.findById(uid).lean();
  const st = saverState(user, now);
  if (!st.available) throw ApiError.conflict('No streak to save right now', 'NO_STREAK_TO_SAVE');
  const token = await redis.getdel(K.saver(uid, today));
  if (!token) throw new ApiError(402, 'AD_REQUIRED', 'Watch a short video to save your streak');
  const restored = user.streakBeforeReset + (user.lastActiveDay === today ? 1 : 0);
  await User.updateOne(
    { _id: uid },
    {
      $set: {
        streak: restored,
        bestStreak: Math.max(user.bestStreak || 0, restored),
        // active today keeps today; otherwise yesterday counts as done
        lastActiveDay: user.lastActiveDay === today ? today : istDayKeyOffset(now, -1),
        streakSaverUsedAt: now,
      },
      $unset: { streakBeforeReset: 1, streakResetDay: 1 },
    },
  );
  notify(uid, { streak: restored, saved: true });
  return { streak: restored };
};

// ---------- goals (32.7 - 32.10) ----------

const goalView = async (uid, defs, period) => {
  const [claimed, ...values] = await Promise.all([
    redis.smembers(K.claimed(uid, period)),
    ...defs.map((g) => redis.get(K.counter(uid, period, g.metric))),
  ]);
  return defs.map((g, i) => {
    const progress = Math.min(Number(values[i]) || 0, g.target);
    return {
      id: g.id,
      title: g.title,
      metric: g.metric,
      target: g.target,
      progress,
      done: progress >= g.target,
      claimed: claimed.includes(g.id),
      reward: g.reward,
    };
  });
};

const getGoals = async (userId) => {
  const uid = String(userId);
  const now = settings.now();
  const { day, week } = periods(now);
  const [user, daily, weekly] = await Promise.all([
    User.findById(uid).lean(),
    goalView(uid, DAILY_GOALS, day),
    goalView(uid, WEEKLY_GOALS, week),
  ]);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  const today = istDayKey(now);
  return {
    streak: {
      current: user.streak || 0,
      best: user.bestStreak || 0,
      activeToday: user.lastActiveDay === today,
      // 32.14 the app warns when this is false late in the day
      atRisk: (user.streak || 0) > 0 && user.lastActiveDay !== today,
      saver: saverState(user, now),
      nextBonusIn: settings.weekBonus ? 7 - ((user.streak || 0) % 7) : null,
      weekBonus: settings.weekBonus,
    },
    aura: user.aura || 0,
    badges: STREAK_BADGES.map((b) => ({ ...b, earned: (user.badges || []).includes(b.id) })),
    daily,
    weekly,
    resetsAt: { daily: istNextDayStart(now), weekly: istNextWeekStart(now) },
  };
};

const claimGoal = async (userId, goalId) => {
  const uid = String(userId);
  const daily = DAILY_GOALS.find((g) => g.id === goalId);
  const weekly = WEEKLY_GOALS.find((g) => g.id === goalId);
  const goal = daily || weekly;
  if (!goal) throw ApiError.notFound('Goal not found', 'GOAL_NOT_FOUND');
  const { day, week } = periods();
  const period = daily ? day : week;
  const progress = Number(await redis.get(K.counter(uid, period, goal.metric))) || 0;
  if (progress < goal.target) throw ApiError.conflict('This goal is not done yet', 'GOAL_NOT_DONE');
  // claim once (SADD returns 1 only for the first claim)
  const first = await redis.sadd(K.claimed(uid, period), goal.id);
  await redis.expire(K.claimed(uid, period), daily ? TTL_DAY : TTL_WEEK);
  if (!first) throw ApiError.conflict('Already claimed', 'GOAL_ALREADY_CLAIMED');
  let balance;
  try {
    if (goal.reward.credits) {
      const res = await wallet().credit({
        userId: uid,
        amount: goal.reward.credits,
        type: 'goal',
        refId: `goal:${uid}:${period}:${goal.id}`,
        meta: { goal: goal.id },
      });
      balance = res.balance;
    }
    await addAura(uid, goal.reward.aura, `goal:${goal.id}`);
  } catch (err) {
    await redis.srem(K.claimed(uid, period), goal.id); // let them try again
    throw err;
  }
  const { aura } = await User.findById(uid).select('aura').lean();
  return { goalId: goal.id, reward: goal.reward, balance, aura };
};

// ---------- leaderboard (32.12) ----------

const leaderboard = async (userId, limit = 20) => {
  const week = istWeekKey(settings.now());
  const key = K.week(week);
  const rows = await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
  const entries = [];
  for (let i = 0; i < rows.length; i += 2) entries.push({ id: rows[i], aura: Number(rows[i + 1]) });
  const users = await User.find({
    _id: { $in: entries.map((e) => e.id).filter((id) => mongoose.isValidObjectId(id)) },
    status: 'active',
  }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const [myRank, myScore] = await Promise.all([
    redis.zrevrank(key, String(userId)),
    redis.zscore(key, String(userId)),
  ]);
  return {
    week,
    items: entries
      .filter((e) => byId.has(e.id))
      .map((e, i) => {
        const p = toPublicUser(byId.get(e.id));
        return {
          rank: i + 1,
          aura: e.aura,
          user: { id: p.id, name: p.name, avatar: p.avatar, premium: p.premium },
        };
      }),
    me: { rank: myRank === null ? null : myRank + 1, aura: Number(myScore) || 0 },
  };
};

// ---------- 32.14 reminder ----------

// 20:00 IST: people with a streak who haven't been active today get a push
const remindStreaks = async () => {
  const today = istDayKey(settings.now());
  const users = await User.find({
    streak: { $gt: 0 },
    lastActiveDay: { $ne: today },
    status: 'active',
    fcmToken: { $exists: true },
    'settings.notifications.streakReminders': { $ne: false }, // 33.7
  })
    .select('_id streak')
    .limit(10000)
    .lean();
  const push = require('./push.service');
  await Promise.all(
    users.map((u) =>
      push.sendToUser(u._id, push.PUSH.STREAK_REMINDER, { streak: u.streak }, { ttlSec: 4 * 3600 }),
    ),
  );
  return users.length ? { reminded: users.length } : null;
};

module.exports = {
  settings,
  grantSaverToken,
  keys: K,
  addAura,
  bump,
  markActiveToday,
  recordConversation,
  resetMissedStreaks,
  useStreakSaver,
  getGoals,
  claimGoal,
  leaderboard,
  remindStreaks,
};
