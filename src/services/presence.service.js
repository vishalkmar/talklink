// Presence & availability (Phase 14). Who is online, and who can receive a random-match request.
//
// States (14.1):
//   offline      no socket for > OFFLINE_GRACE_MS
//   online_idle  connected, but not taking random requests (toggle off / app in background /
//                Do Not Disturb / matching paused / invisible)
//   available    connected, foreground, toggle on, eligible -> in the random pools
//   searching    waiting for their own match request (Phase 15)
//   in_call      on an audio call            (Phase 17-22)
//   in_chat      in a random text session    (Phase 25)
//
// Redis (14.2 / 14.3 / 14.16):
//   presence:<uid>         HASH { state, gender, wants, fg, eligible, lastSeen }   TTL 150 s
//   online:all             ZSET uid -> last heartbeat ms   (online count)
//   available:all          ZSET uid -> last heartbeat ms   (random pool, any gender)
//   available:male|female  ZSET uid -> last heartbeat ms   (gender-filtered pools)
// Sorted sets scored by heartbeat time: a member that stops heartbeating is "stale" after
// STALE_MS and is ignored/cleaned, so a crashed server can never leave users stuck as available.
const { redis } = require('../config/redis');
const User = require('../models/User');
const logger = require('../utils/logger');
const registry = require('../sockets/registry');

const STATE = Object.freeze({
  OFFLINE: 'offline',
  ONLINE_IDLE: 'online_idle',
  AVAILABLE: 'available',
  SEARCHING: 'searching',
  IN_CALL: 'in_call',
  IN_CHAT: 'in_chat',
});
const BUSY = new Set([STATE.SEARCHING, STATE.IN_CALL, STATE.IN_CHAT]);

// Tunables (tests shorten them).
const settings = {
  presenceTtlSec: 150,
  staleMs: 120 * 1000,
  offlineGraceMs: 10 * 1000,
  heartbeatMs: 45 * 1000,
};

const K = {
  presence: (uid) => `presence:${uid}`,
  online: 'online:all',
  available: 'available:all',
  availableGender: (g) => `available:${g}`,
};
const GENDER_POOLS = ['male', 'female']; // "other" is only in available:all

const offlineTimers = new Map(); // uid -> timeout (this process only)

// ---------- eligibility (14.9 / 14.14 / 14.15) ----------

const IST_OFFSET_MIN = 330; // India has no DST
const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Is `date` inside the user's daily Do-Not-Disturb window (IST)? Handles windows over midnight.
const isWithinDnd = (dnd, date = new Date()) => {
  if (!dnd || !dnd.enabled) return false;
  const start = toMinutes(dnd.start);
  const end = toMinutes(dnd.end);
  if (start === null || end === null || start === end) return false;
  const now = (date.getUTCHours() * 60 + date.getUTCMinutes() + IST_OFFSET_MIN) % 1440;
  return start < end ? now >= start && now < end : now >= start || now < end;
};

const isEligibleForRandom = (user, date = new Date()) =>
  Boolean(user) &&
  user.status === 'active' &&
  !(user.settings && user.settings.invisible) &&
  !(user.matchingPausedUntil && user.matchingPausedUntil > date) &&
  !isWithinDnd(user.settings && user.settings.dnd, date);

const loadUser = (uid) =>
  User.findById(uid).select('gender status settings matchingPausedUntil').lean();

// ---------- core ----------

const getPresence = async (uid) => {
  const h = await redis.hgetall(K.presence(uid));
  if (!h || !h.state)
    return { state: STATE.OFFLINE, lastSeen: h && h.lastSeen ? Number(h.lastSeen) : null };
  return {
    state: h.state,
    gender: h.gender || null,
    wantsAvailable: h.wants === '1',
    foreground: h.fg === '1',
    eligible: h.eligible === '1',
    autoAccept: h.auto === '1',
    lastSeen: Number(h.lastSeen) || null,
  };
};

const removeFromPools = (multi, uid) => {
  multi.zrem(K.available, uid);
  GENDER_POOLS.forEach((g) => multi.zrem(K.availableGender(g), uid));
};

// Puts the user in / takes them out of the random pools according to the stored hash.
const reconcile = async (uid) => {
  const p = await getPresence(uid);
  if (p.state === STATE.OFFLINE) return p.state;
  const now = Date.now();
  const multi = redis.multi();
  let state = p.state;
  if (!BUSY.has(p.state)) {
    state = p.wantsAvailable && p.foreground && p.eligible ? STATE.AVAILABLE : STATE.ONLINE_IDLE;
    multi.hset(K.presence(uid), 'state', state);
  }
  if (state === STATE.AVAILABLE) {
    multi.zadd(K.available, now, uid);
    if (GENDER_POOLS.includes(p.gender)) multi.zadd(K.availableGender(p.gender), now, uid);
  } else {
    removeFromPools(multi, uid);
  }
  multi.expire(K.presence(uid), settings.presenceTtlSec);
  await multi.exec();
  return state;
};

// 14.4 socket connected (first or additional device).
const onConnect = async (uid) => {
  const pending = offlineTimers.get(uid);
  if (pending) {
    clearTimeout(pending);
    offlineTimers.delete(uid);
  }
  const user = await loadUser(uid);
  const existing = await getPresence(uid);
  const now = Date.now();
  await redis
    .multi()
    .hset(K.presence(uid), {
      // keep a busy state (e.g. reconnect during a call); otherwise start idle until the app reports
      state: BUSY.has(existing.state) ? existing.state : STATE.ONLINE_IDLE,
      gender: (user && user.gender) || '',
      eligible: isEligibleForRandom(user) ? '1' : '0',
      lastSeen: now,
    })
    .expire(K.presence(uid), settings.presenceTtlSec)
    .zadd(K.online, now, uid)
    .exec();
  return reconcile(uid);
};

// 14.5 / 14.6 the app reports its toggle + foreground state.
const setClientState = async (uid, { available, foreground, autoAccept = false }) => {
  const user = await loadUser(uid);
  await redis.hset(K.presence(uid), {
    wants: available ? '1' : '0',
    fg: foreground ? '1' : '0',
    auto: autoAccept ? '1' : '0', // 15.17 accept random requests automatically
    eligible: isEligibleForRandom(user) ? '1' : '0',
    gender: (user && user.gender) || '',
  });
  return reconcile(uid);
};

// 14.7 entering a call / search / chat removes the user from the pools.
const setBusy = async (uid, state) => {
  if (!BUSY.has(state)) throw new Error(`Not a busy state: ${state}`);
  const multi = redis.multi();
  multi.hset(K.presence(uid), 'state', state);
  removeFromPools(multi, uid);
  multi.expire(K.presence(uid), settings.presenceTtlSec);
  await multi.exec();
  return state;
};

// 14.8 call / search / chat ended -> back to available if the toggle is on.
const clearBusy = async (uid) => {
  const p = await getPresence(uid);
  if (p.state === STATE.OFFLINE) return p.state;
  await redis.hset(K.presence(uid), 'state', STATE.ONLINE_IDLE);
  return reconcile(uid);
};

// Heartbeat from a live socket: keeps scores fresh and the hash alive.
const touch = async (uid) => {
  const p = await getPresence(uid);
  if (p.state === STATE.OFFLINE) return;
  const now = Date.now();
  const multi = redis.multi();
  multi.zadd(K.online, now, uid);
  multi.hset(K.presence(uid), 'lastSeen', now);
  multi.expire(K.presence(uid), settings.presenceTtlSec);
  if (p.state === STATE.AVAILABLE) {
    multi.zadd(K.available, 'XX', now, uid);
    if (GENDER_POOLS.includes(p.gender)) multi.zadd(K.availableGender(p.gender), 'XX', now, uid);
  }
  await multi.exec();
};

const markOffline = async (uid) => {
  const now = Date.now();
  const multi = redis.multi();
  removeFromPools(multi, uid);
  multi.zrem(K.online, uid);
  multi.hset(K.presence(uid), { state: STATE.OFFLINE, lastSeen: now });
  multi.expire(K.presence(uid), settings.presenceTtlSec);
  await multi.exec();
  await User.updateOne({ _id: uid }, { $set: { lastSeenAt: new Date(now) } }); // 14.12
};

// 14.4 / 14.13 last device gone -> offline after a short grace (app restart, network switch).
const onDisconnect = (uid, remainingSockets) => {
  if (remainingSockets > 0) return;
  if (offlineTimers.has(uid)) clearTimeout(offlineTimers.get(uid));
  const timer = setTimeout(async () => {
    offlineTimers.delete(uid);
    try {
      if ((await registry.socketCount(uid)) > 0) return; // reconnected (maybe on another instance)
      await markOffline(uid);
    } catch (err) {
      logger.error({ err, uid }, 'Presence offline transition failed');
    }
  }, settings.offlineGraceMs);
  if (timer.unref) timer.unref();
  offlineTimers.set(uid, timer);
};

// 14.10 people online right now (fresh heartbeat).
const onlineCount = () => redis.zcount(K.online, Date.now() - settings.staleMs, '+inf');

// Fresh members of a random pool (Phase 15). pool: 'all' | 'male' | 'female'.
const availableUserIds = (pool = 'all') =>
  redis.zrangebyscore(
    pool === 'all' ? K.available : K.availableGender(pool),
    Date.now() - settings.staleMs,
    '+inf',
  );

// Is the user free for a direct call / match right now? (Phase 15 / 22)
const isAvailable = async (uid) => (await getPresence(uid)).state === STATE.AVAILABLE;

// 14.11 drop members that stopped heartbeating (crashed instance, killed app).
const cleanupStale = async () => {
  const cutoff = Date.now() - settings.staleMs;
  const keys = [K.online, K.available, ...GENDER_POOLS.map(K.availableGender)];
  const removed = await Promise.all(keys.map((k) => redis.zremrangebyscore(k, '-inf', cutoff)));
  return removed.reduce((a, b) => a + b, 0);
};

// 14.18 debug numbers for the admin endpoint.
const debugCounts = async () => {
  const fresh = Date.now() - settings.staleMs;
  const [online, available, male, female] = await Promise.all([
    redis.zcount(K.online, fresh, '+inf'),
    redis.zcount(K.available, fresh, '+inf'),
    redis.zcount(K.availableGender('male'), fresh, '+inf'),
    redis.zcount(K.availableGender('female'), fresh, '+inf'),
  ]);
  return { online, available, availableByGender: { male, female }, staleAfterMs: settings.staleMs };
};

const __clearTimersForTests = () => {
  offlineTimers.forEach((t) => clearTimeout(t));
  offlineTimers.clear();
};

module.exports = {
  STATE,
  settings,
  keys: K,
  isWithinDnd,
  isEligibleForRandom,
  getPresence,
  onConnect,
  setClientState,
  setBusy,
  clearBusy,
  touch,
  markOffline,
  onDisconnect,
  onlineCount,
  isAvailable,
  availableUserIds,
  cleanupStale,
  debugCounts,
  __clearTimersForTests,
};
