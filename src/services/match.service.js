// Matchmaking engine (Phase 15): ride-hailing style broadcast, first accept wins.
//
//  requestMatch()  caller asks for a random partner (audio | text, anyone | male | female)
//    -> waves: every waveIntervalMs, offer the request to up to waveSize fresh available users
//       (never: self, blocked either way, matched together in the last 10 min, already offered,
//       declined, or users already looking at another offer)
//  acceptMatch()   first candidate to win the store lock gets the match -> match:found to both,
//                  match:cancelled to everyone else, Call document created, both marked busy
//  declineMatch()  candidate says no (request keeps going)
//  cancelMatch()   caller gives up -> candidates' popups close
//  timeout         nobody accepted in timeoutMs -> match:timeout to the caller
//
// ONE lock (`match:<id>:lock`, SET NX) decides the outcome - accept, timeout and cancel all race
// for it, so exactly one of them wins even across server instances.
//
// Store: match:<id> (hash), match:<id>:notified (set), match:<id>:declined (set),
//        match:<id>:lock, match:active:<callerId>, offer:<uid>, recent:<uid> (zset)
const crypto = require('crypto');
const { store } = require('../config/store');
const User = require('../models/User');
const { blockedIdsOf } = require('./block.service');
const Call = require('../models/Call');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { toPublicUser } = require('../utils/serializers');
const presence = require('./presence.service');
const filterService = require('./filter.service');
const callSession = require('./callSession.service');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

// Tunables (tests shorten them).
const settings = {
  waveSize: 20, // 15.6
  waveIntervalMs: 5000,
  timeoutMs: 30000, // 15.12
  offerTtlSec: 15, // popup lifetime on the candidate (16.11)
  recentPairMs: 10 * 60 * 1000, // 15.15
  lockTtlSec: 60,
};

const MODES = ['audio', 'text'];
const CONNECT_WITH = ['anyone', 'male', 'female'];

const K = {
  req: (id) => `match:${id}`,
  notified: (id) => `match:${id}:notified`,
  declined: (id) => `match:${id}:declined`,
  lock: (id) => `match:${id}:lock`,
  active: (uid) => `match:active:${uid}`,
  offer: (uid) => `offer:${uid}`,
  recent: (uid) => `recent:${uid}`,
};

// requestId -> { wave, timeout, excluded:Set } (timers live on the instance that took the request)
const local = new Map();

const ttlSec = () => Math.ceil(settings.timeoutMs / 1000) + 10;

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const publicInfo = (u) => {
  const p = toPublicUser(u);
  return { id: p.id, name: p.name, gender: p.gender, avatar: p.avatar };
};

// Everyone the caller must never be matched with: blocks both ways + recent partners.
const excludedFor = async (uid) => {
  const [blocked, recent] = await Promise.all([
    blockedIdsOf(uid), // 26.10 both directions, cached
    (async () => {
      await store.zremrangebyscore(K.recent(uid), '-inf', Date.now() - settings.recentPairMs);
      return store.zrange(K.recent(uid), 0, -1);
    })(),
  ]);
  const set = new Set(recent);
  set.add(uid);
  blocked.forEach((id) => set.add(id));
  return set;
};

const stopTimers = (id) => {
  const entry = local.get(id);
  if (!entry) return;
  clearInterval(entry.wave);
  clearTimeout(entry.timeout);
  local.delete(id);
};

// Releases offers that still point at this request (so those users can get new requests).
const releaseOffers = async (id, uids) => {
  if (!uids.length) return;
  const current = await store.mget(uids.map(K.offer));
  const mine = uids.filter((u, i) => current[i] === id);
  if (mine.length) await store.del(...mine.map(K.offer));
};

// ---------- waves ----------

const runWave = async (id) => {
  const req = await store.hgetall(K.req(id));
  if (!req.callerId || req.status !== 'pending') return stopTimers(id);

  const entry = local.get(id);
  const excluded = entry ? entry.excluded : await excludedFor(req.callerId);
  const [pool, notified, declined] = await Promise.all([
    presence.availableUserIds(req.filter === 'anyone' ? 'all' : req.filter),
    store.smembers(K.notified(id)),
    store.smembers(K.declined(id)),
  ]);
  const skip = new Set([...excluded, ...notified, ...declined]);
  const offerable = shuffle(pool.filter((uid) => !skip.has(uid)));

  const chosen = [];
  for (const uid of offerable) {
    if (chosen.length >= (req.premium === '1' ? settings.waveSize * 2 : settings.waveSize)) break;
    // one popup at a time per candidate

    const ok = await store.set(K.offer(uid), id, 'EX', settings.offerTtlSec, 'NX');
    if (ok) chosen.push(uid);
  }
  if (!chosen.length) return undefined;

  await store
    .multi()
    .sadd(K.notified(id), ...chosen)
    .expire(K.notified(id), ttlSec())
    .exec();
  const offerExpiresAt = Math.min(Date.now() + settings.offerTtlSec * 1000, Number(req.expiresAt));
  emitter.emitToUsers(chosen, EVENTS.MATCH_INCOMING, {
    requestId: id,
    mode: req.mode,
    caller: JSON.parse(req.caller),
    expiresAt: offerExpiresAt,
  });

  // 15.17 candidates who opted into auto-accept take it straight away (the lock still decides).
  const states = await Promise.all(chosen.map((uid) => presence.getPresence(uid)));
  chosen
    .filter((uid, i) => states[i].autoAccept)
    .forEach((uid) => {
      acceptMatch(uid, id).catch(() => {});
    });
  return chosen;
};

// ---------- outcomes ----------

// Timeout or cancel. Returns false if an accept (or another close) already won the lock.
const closeUnmatched = async (id, status) => {
  const won = await store.set(K.lock(id), `closed:${status}`, 'EX', settings.lockTtlSec, 'NX');
  if (!won) return false;
  stopTimers(id);
  const req = await store.hgetall(K.req(id));
  if (!req.callerId) return false;
  await store.hset(K.req(id), 'status', status);
  const notified = await store.smembers(K.notified(id));
  await Promise.all([
    store.del(K.active(req.callerId)),
    releaseOffers(id, notified),
    presence.clearBusy(req.callerId),
  ]);
  emitter.emitToUsers(notified, EVENTS.MATCH_CANCELLED, { requestId: id, reason: status });
  if (status === 'timeout') {
    // 30.9 nobody found with the gender filter -> an unused pass is refunded
    const refunded =
      req.filter && req.filter !== 'anyone'
        ? await filterService.refundIfUnused(req.callerId).catch((err) => {
            logger.error({ err }, 'filter refund failed');
            return false;
          })
        : false;
    emitter.emitToUser(req.callerId, EVENTS.MATCH_TIMEOUT, { requestId: id, refunded });
  }
  logger.info(
    { requestId: id, callerId: req.callerId, status, offered: notified.length },
    'Match closed',
  );
  return true;
};

// ---------- public API ----------

const requestMatch = async (callerId, { mode, connectWith }) => {
  if (!MODES.includes(mode) || !CONNECT_WITH.includes(connectWith)) {
    throw ApiError.badRequest('Invalid mode or connectWith', 'VALIDATION_ERROR');
  }
  const caller = await User.findById(callerId).lean();
  if (!caller || caller.status !== 'active')
    throw ApiError.forbidden('Account not active', 'ACCOUNT_SUSPENDED');
  if (!caller.name || !caller.gender)
    throw ApiError.badRequest('Finish your profile first', 'PROFILE_INCOMPLETE');

  // 15.3 gender filter is a paid/earned feature
  if (
    connectWith !== 'anyone' &&
    !(await filterService.hasGenderFilterAccess(caller, connectWith))
  ) {
    throw new ApiError(403, 'FILTER_LOCKED', 'Unlock the gender filter to use it');
  }

  const state = (await presence.getPresence(callerId)).state;
  if ([presence.STATE.IN_CALL, presence.STATE.IN_CHAT].includes(state)) {
    throw ApiError.conflict('You are already in a call or chat', 'BUSY');
  }

  // 15.16 only one pending request per user
  const requestId = crypto.randomUUID();
  const claimed = await store.set(K.active(callerId), requestId, 'EX', ttlSec(), 'NX');
  if (!claimed) {
    const existing = await store.get(K.active(callerId));
    throw new ApiError(409, 'ALREADY_SEARCHING', 'You are already looking for someone', {
      requestId: existing,
    });
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + settings.timeoutMs;
  await store
    .multi()
    .hset(K.req(requestId), {
      callerId,
      mode,
      filter: connectWith,
      status: 'pending',
      createdAt,
      expiresAt,
      caller: JSON.stringify(publicInfo(caller)),
      premium: filterService.isPremiumActive(caller) ? '1' : '0', // 31.4 bigger waves
    })
    .expire(K.req(requestId), ttlSec())
    .exec();
  await presence.setBusy(callerId, presence.STATE.SEARCHING); // 14.7

  const entry = { excluded: await excludedFor(callerId) };
  local.set(requestId, entry);
  entry.wave = setInterval(() => {
    runWave(requestId).catch((err) => logger.error({ err, requestId }, 'Match wave failed'));
  }, settings.waveIntervalMs);
  entry.timeout = setTimeout(() => {
    closeUnmatched(requestId, 'timeout').catch((err) =>
      logger.error({ err }, 'Match timeout failed'),
    );
  }, settings.timeoutMs);
  runWave(requestId).catch((err) => logger.error({ err, requestId }, 'Match wave failed'));

  logger.info({ requestId, callerId, mode, connectWith }, 'Match requested');
  return { requestId, expiresAt };
};

const acceptMatch = async (uid, requestId) => {
  const req = await store.hgetall(K.req(requestId));
  if (!req.callerId) throw ApiError.notFound('This request has ended', 'REQUEST_NOT_FOUND');
  if (req.callerId === uid)
    throw ApiError.badRequest('You cannot accept your own request', 'INVALID');
  if (!(await store.sismember(K.notified(requestId), uid))) {
    throw ApiError.forbidden('This request was not offered to you', 'NOT_INVITED');
  }
  if (req.status !== 'pending') throw ApiError.conflict('Someone else picked it up', 'TAKEN');
  if (!(await presence.isAvailable(uid))) {
    throw ApiError.conflict('You are busy right now', 'NOT_AVAILABLE');
  }

  // 15.8 first accept wins
  const won = await store.set(K.lock(requestId), uid, 'EX', settings.lockTtlSec, 'NX');
  if (!won) {
    const holder = await store.get(K.lock(requestId));
    if (holder && holder.startsWith('closed:')) {
      throw ApiError.conflict('This request has ended', 'REQUEST_CLOSED');
    }
    throw ApiError.conflict('Someone else picked it up', 'TAKEN');
  }

  // 15.9 winner
  stopTimers(requestId);
  await store.hset(K.req(requestId), { status: 'matched', calleeId: uid });
  const busy = req.mode === 'audio' ? presence.STATE.IN_CALL : presence.STATE.IN_CHAT;
  const [accepter] = await Promise.all([
    User.findById(uid).lean(),
    presence.setBusy(req.callerId, busy),
    presence.setBusy(uid, busy),
  ]);
  // 15.14 audio: 'ringing' until WebRTC connects (Phase 17); text sessions start right away
  const call = await Call.create({
    callerId: req.callerId,
    calleeId: uid,
    mode: req.mode,
    matchType: 'random',
    status: req.mode === 'text' ? 'active' : 'ringing',
    startedAt: req.mode === 'text' ? new Date() : undefined,
  });
  const roomId = String(call._id);
  let conversationId = null;
  if (req.mode === 'text') {
    // 25.2 temporary chat; required here because session.service needs this module (next)
    conversationId = await require('./session.service').createSession({
      callId: roomId,
      callerId: req.callerId,
      calleeId: uid,
      connectWith: req.filter || 'anyone',
    });
  }
  if (req.mode === 'audio') {
    await callSession.registerCall({
      roomId,
      callerId: req.callerId,
      calleeId: uid,
      mode: 'audio',
    }); // 17.7
  }

  const now = Date.now();
  const notified = await store.smembers(K.notified(requestId));
  await Promise.all([
    // 15.15 don't pair these two again for a while
    store
      .multi()
      .zadd(K.recent(req.callerId), now, uid)
      .expire(K.recent(req.callerId), 3600)
      .exec(),
    store.multi().zadd(K.recent(uid), now, req.callerId).expire(K.recent(uid), 3600).exec(),
    store.del(K.active(req.callerId)),
    releaseOffers(requestId, notified),
  ]);

  const callerInfo = JSON.parse(req.caller);
  const accepterInfo = publicInfo(accepter);
  if (req.filter && req.filter !== 'anyone') await filterService.markMatched(req.callerId); // 30.9
  emitter.emitToUser(req.callerId, EVENTS.MATCH_FOUND, {
    requestId,
    roomId,
    mode: req.mode,
    role: 'caller',
    peer: accepterInfo,
    conversationId,
  });
  emitter.emitToUser(uid, EVENTS.MATCH_FOUND, {
    requestId,
    roomId,
    mode: req.mode,
    role: 'callee',
    peer: callerInfo,
    conversationId,
  });
  // 15.10 everyone else's popup closes
  const losers = notified.filter((x) => x !== uid);
  emitter.emitToUsers(losers, EVENTS.MATCH_CANCELLED, { requestId, reason: 'taken' });

  logger.info({ requestId, roomId, callerId: req.callerId, calleeId: uid }, 'Match found');
  return { roomId, mode: req.mode, role: 'callee', peer: callerInfo, conversationId };
};

// 15.11 a candidate says no - recorded so they are not offered it again.
const declineMatch = async (uid, requestId) => {
  if (!(await store.sismember(K.notified(requestId), uid))) return { declined: false };
  await store
    .multi()
    .sadd(K.declined(requestId), uid)
    .expire(K.declined(requestId), ttlSec())
    .exec();
  await releaseOffers(requestId, [uid]);
  return { declined: true };
};

// 15.13 caller gives up.
const cancelMatch = async (uid, requestId) => {
  const req = await store.hgetall(K.req(requestId));
  if (!req.callerId) return { cancelled: false };
  if (req.callerId !== uid) throw ApiError.forbidden('Not your request', 'FORBIDDEN');
  return { cancelled: await closeUnmatched(requestId, 'cancelled') };
};

// Caller's last device went away while searching -> nobody to connect to.
const onUserGone = async (uid) => {
  const requestId = await store.get(K.active(uid));
  if (requestId) await closeUnmatched(requestId, 'cancelled');
};

const __resetForTests = () => {
  [...local.keys()].forEach(stopTimers);
};

module.exports = {
  settings,
  keys: K,
  requestMatch,
  acceptMatch,
  declineMatch,
  cancelMatch,
  onUserGone,
  runWave,
  __resetForTests,
};
