// Gender filter (who may use connectWith: male / female) - Phase 15 check, Phase 30 unlock.
//
// Model (ADR-035): a TIME PASS. Unlocking spends GENDER_FILTER_COST credits and opens the chosen
// filter for GENDER_FILTER_PASS_MIN minutes. Fairness (30.9): if a search with the filter times
// out before the pass ever produced a match, the credits are refunded automatically and the pass
// closes. Premium users never pay (30.10).
//
// Store  filter:unlocked:<uid> = JSON { gender, until, ref, matched } (TTL = pass length)
const crypto = require('crypto');
const config = require('../config');
const { store } = require('../config/store');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

const GENDERS = ['male', 'female'];

const settings = {
  cost: config.economy.genderFilterCost,
  passMs: config.economy.genderFilterPassMin * 60 * 1000,
};

const unlockKey = (uid) => `filter:unlocked:${uid}`;

const isPremiumActive = (user) =>
  Boolean(user && user.isPremium && (!user.premiumUntil || user.premiumUntil > new Date()));

const readPass = async (uid) => {
  const raw = await store.get(unlockKey(String(uid)));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : { gender: null };
  } catch {
    return { gender: null }; // legacy / test marker: any gender
  }
};

// gender omitted -> any active pass
const hasGenderFilterAccess = async (user, gender) => {
  if (isPremiumActive(user)) return true;
  const pass = await readPass(user._id);
  if (!pass) return false;
  return !gender || !pass.gender || pass.gender === gender;
};

const publicPass = (pass) =>
  pass && pass.gender ? { gender: pass.gender, until: new Date(pass.until) } : null;

const notify = (uid, payload) => emitter.emitToUser(String(uid), EVENTS.FILTER_UPDATED, payload);

// GET /filters
const getStatus = async (user) => ({
  cost: settings.cost,
  passMinutes: Math.round(settings.passMs / 60000),
  premium: isPremiumActive(user),
  active: publicPass(await readPass(user._id)),
});

// 30.7 POST /filters/unlock { gender }
const unlock = async (user, gender) => {
  if (!GENDERS.includes(gender))
    throw ApiError.badRequest('Choose male or female', 'VALIDATION_ERROR');
  if (isPremiumActive(user)) return { gender, premium: true, until: null };
  const uid = String(user._id);
  const current = await readPass(uid);
  if (current && current.gender === gender) {
    return { gender, until: new Date(current.until), alreadyActive: true };
  }
  // the wallet is required here: wallet -> sockets -> ... -> match -> filter would be a cycle
  const wallet = require('./wallet.service');
  const ref = `filter:${uid}:${crypto.randomUUID()}`;
  const debit = await wallet.debit({
    userId: uid,
    amount: settings.cost,
    type: 'gender_filter',
    refId: ref,
    meta: { gender, passMin: Math.round(settings.passMs / 60000) },
  });
  const until = Date.now() + settings.passMs;
  // switching filter (female -> male) replaces the previous pass; it had already been used
  await store.set(
    unlockKey(uid),
    JSON.stringify({ gender, until, ref, matched: false }),
    'PX',
    settings.passMs,
  );
  notify(uid, { active: { gender, until: new Date(until) } });
  logger.info({ userId: uid, gender }, 'Gender filter unlocked');
  return { gender, until: new Date(until), balance: debit.balance };
};

// a filtered search found someone: the pass has done its job (no refund any more)
const markMatched = async (uid) => {
  const key = unlockKey(String(uid));
  const pass = await readPass(uid);
  if (!pass || !pass.ref || pass.matched) return;
  const ttl = await store.pttl(key);
  if (ttl > 0) await store.set(key, JSON.stringify({ ...pass, matched: true }), 'PX', ttl);
};

// 30.9 a filtered search timed out: refund an unused pass. Returns true when refunded.
const refundIfUnused = async (uid) => {
  const key = unlockKey(String(uid));
  const pass = await readPass(uid);
  if (!pass || !pass.ref || pass.matched) return false;
  // claim the refund once (two timeouts at once can't both pay)
  if (!(await store.set(`${key}:refund`, '1', 'EX', 3600, 'NX'))) return false;
  const wallet = require('./wallet.service');
  await wallet.credit({
    userId: String(uid),
    amount: settings.cost,
    type: 'refund',
    refId: `refund:${pass.ref}`,
    meta: { reason: 'no_match', gender: pass.gender },
  });
  await store.del(key, `${key}:refund`);
  notify(uid, { active: null, refunded: true, credits: settings.cost });
  logger.info({ userId: String(uid), gender: pass.gender }, 'Gender filter refunded');
  return true;
};

module.exports = {
  GENDERS,
  settings,
  unlockKey,
  isPremiumActive,
  hasGenderFilterAccess,
  getStatus,
  unlock,
  markMatched,
  refundIfUnused,
};
