// Rewarded ads (Phase 28). The app never decides a reward on its own in production:
//
//  1. app: POST /ads/nonce { purpose } -> nonce (store, 1 h, tied to the user + purpose)
//  2. app shows the ad with serverSideVerificationOptions { userId, customData: nonce }
//  3. Google calls GET /ads/ssv?...&signature=&key_id= (server-side verification, SSV)
//  4. server checks Google's ECDSA signature, the nonce, the ad unit and the daily limit, then
//     credits once per transaction_id (refId ad:<transaction_id>) -> wallet:updated to the app
//
// Without a public URL (local dev) set ADMOB_SSV_ENABLED=false: the app then claims the reward
// itself with POST /ads/claim { nonce } (still one reward per nonce, same daily limit).
// purpose: 'credits' -> AD_REWARD_CREDITS; 'spin' -> one extra spin today (Phase 29).
const crypto = require('crypto');
const config = require('../config');
const { store } = require('../config/store');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { istDayKey } = require('../utils/istDay');
const wallet = require('./wallet.service');

const PURPOSES = ['credits', 'spin', 'streak'];
const NONCE_TTL_SEC = 3600;
const KEYS_TTL_MS = 24 * 3600 * 1000;

const settings = {
  ssvEnabled: config.admob.ssvEnabled,
  keysUrl: config.admob.ssvKeysUrl,
  adUnitIds: config.admob.adUnitIds,
  dailyLimit: config.economy.dailyAdLimit,
  rewardCredits: config.economy.adRewardCredits,
  blockEmulators: config.economy.blockEmulators,
};

const K = {
  nonce: (n) => `ad:nonce:${n}`,
  today: (uid, day = istDayKey()) => `ad:count:${uid}:${day}`,
  extraSpins: (uid, day = istDayKey()) => `spin:extra:${uid}:${day}`,
};

// ---------- nonce ----------

// device: { emulator } reported by the app (30.16) - a basic extra layer; SSV + limits are the
// real protection because an app report can be faked
const createNonce = async (userId, purpose = 'credits', device = {}) => {
  if (!PURPOSES.includes(purpose)) {
    throw ApiError.badRequest('Unknown ad purpose', 'VALIDATION_ERROR');
  }
  if (settings.blockEmulators && device && device.emulator) {
    logger.warn({ userId: String(userId) }, 'Ad reward refused on an emulator');
    throw ApiError.forbidden('Rewards are not available on this device', 'REWARDS_UNAVAILABLE');
  }
  const used = Number(await store.get(K.today(String(userId)))) || 0;
  if (used >= settings.dailyLimit) {
    throw new ApiError(429, 'DAILY_LIMIT', 'You have watched all videos for today');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  await store.set(
    K.nonce(nonce),
    JSON.stringify({ uid: String(userId), purpose }),
    'EX',
    NONCE_TTL_SEC,
  );
  return { nonce, purpose, ssv: settings.ssvEnabled, left: settings.dailyLimit - used };
};

// ---------- Google's keys + signature (28.11) ----------

let keyCache = { at: 0, keys: new Map() };
let fetchKeys = async () => {
  const res = await fetch(settings.keysUrl);
  if (!res.ok) throw new Error(`SSV keys HTTP ${res.status}`);
  const body = await res.json();
  return new Map((body.keys || []).map((k) => [String(k.keyId), k.pem]));
};

const getKey = async (keyId) => {
  if (!keyCache.keys.has(String(keyId)) || Date.now() - keyCache.at > KEYS_TTL_MS) {
    keyCache = { at: Date.now(), keys: await fetchKeys() };
  }
  return keyCache.keys.get(String(keyId)) || null;
};

const fromWebSafeBase64 = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// rawQuery = the query string exactly as Google sent it (order matters). The signed message is
// everything before "&signature=".
const verifySignature = async (rawQuery) => {
  const idx = rawQuery.indexOf('&signature=');
  if (idx < 0) return null;
  const message = rawQuery.slice(0, idx);
  const params = new URLSearchParams(rawQuery);
  const signature = params.get('signature');
  const keyId = params.get('key_id');
  if (!signature || !keyId) return null;
  const pem = await getKey(keyId);
  if (!pem) return null;
  const ok = crypto.verify(
    'sha256',
    Buffer.from(message, 'utf8'),
    { key: pem, dsaEncoding: 'der' },
    fromWebSafeBase64(signature),
  );
  return ok ? params : null;
};

// ---------- granting ----------

const grant = async ({ userId, nonce, transactionId, adUnit, source }) => {
  const raw = await store.getdel(K.nonce(nonce));
  if (!raw) return { granted: false, reason: 'NONCE_INVALID' };
  const { uid, purpose } = JSON.parse(raw);
  if (uid !== String(userId)) return { granted: false, reason: 'NONCE_INVALID' };

  // 28.13 daily limit (counts every rewarded ad, both purposes)
  const countKey = K.today(uid);
  const n = await store.incr(countKey);
  if (n === 1) await store.expire(countKey, 2 * 24 * 3600);
  if (n > settings.dailyLimit) return { granted: false, reason: 'DAILY_LIMIT' };

  if (purpose === 'streak') {
    // 32.13 one streak-saver token for today (used by POST /goals/streak-saver); the gamification
    // service owns the key and its clock (lazy require: gamification -> wallet -> ... cycle)
    await require('./gamification.service').grantSaverToken(uid);
    return { granted: true, purpose, streakSaver: 1 };
  }
  if (purpose === 'spin') {
    const key = K.extraSpins(uid);
    await store
      .multi()
      .incr(key)
      .expire(key, 2 * 24 * 3600)
      .exec();
    logger.info({ userId: uid, source }, 'Ad reward: extra spin');
    return { granted: true, purpose, extraSpin: 1 };
  }
  const res = await wallet.credit({
    userId: uid,
    amount: settings.rewardCredits,
    type: 'ad_reward',
    refId: `ad:${transactionId}`,
    meta: { adUnit: adUnit || null, source },
  });
  return { granted: res.applied, purpose, credits: settings.rewardCredits, balance: res.balance };
};

// GET /ads/ssv (28.9 - 28.11). Returns { status, body } - always 200 once the signature is valid
// (Google retries on errors; a duplicate / over-limit reward is simply not paid again).
const handleSsv = async (rawQuery) => {
  const params = await verifySignature(rawQuery);
  if (!params) return { status: 403, body: { ok: false, code: 'INVALID_SIGNATURE' } };
  const userId = params.get('user_id');
  const nonce = params.get('custom_data');
  const transactionId = params.get('transaction_id');
  const adUnit = params.get('ad_unit');
  if (!userId || !nonce || !transactionId) {
    return { status: 200, body: { ok: true, ignored: 'MISSING_FIELDS' } }; // console test ping
  }
  if (
    settings.adUnitIds.length &&
    !settings.adUnitIds.some((id) => id.endsWith(`/${adUnit}`) || id === adUnit)
  ) {
    logger.warn({ adUnit }, 'SSV for an unknown ad unit');
    return { status: 200, body: { ok: true, ignored: 'UNKNOWN_AD_UNIT' } };
  }
  const result = await grant({ userId, nonce, transactionId, adUnit, source: 'ssv' });
  if (!result.granted) logger.info({ userId, reason: result.reason }, 'SSV reward not paid');
  return { status: 200, body: { ok: true, granted: result.granted } };
};

// POST /ads/claim - only when SSV is switched off (dev)
const claim = async (userId, { nonce }) => {
  if (settings.ssvEnabled) return { pending: true }; // the SSV callback will pay
  const result = await grant({
    userId: String(userId),
    nonce,
    transactionId: `client:${nonce}`,
    source: 'client',
  });
  if (!result.granted && result.reason === 'DAILY_LIMIT') {
    throw new ApiError(429, 'DAILY_LIMIT', 'You have watched all videos for today');
  }
  if (!result.granted) throw ApiError.badRequest('This reward was already used', 'NONCE_INVALID');
  return result;
};

const extraSpinsToday = async (userId) =>
  Number(await store.get(K.extraSpins(String(userId)))) || 0;

// tests
const __setKeyFetcherForTests = (fn) => {
  fetchKeys = fn;
  keyCache = { at: 0, keys: new Map() };
};

module.exports = {
  settings,
  PURPOSES,
  keys: K,
  createNonce,
  verifySignature,
  handleSsv,
  claim,
  extraSpinsToday,
  __setKeyFetcherForTests,
};
