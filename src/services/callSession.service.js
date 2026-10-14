// Live audio call sessions (Phase 17): who is in which call, relaying signaling to the right
// device, connect / end bookkeeping, peer-lost grace and the max-duration safety limit.
//
// Store:
//   call:<roomId>        HASH { callerId, calleeId, mode, state, createdAt, startedAt,
//                               callerSock, calleeSock, blockChecked,
//                               awaitingAnswer ('1' while a direct call rings, Phase 21) }
//                        TTL = max duration + 10 min
//   call:<roomId>:ended  STRING (SET NX) - endCall() runs exactly once, on any instance
//   user:<uid>:call      STRING roomId   - the call this user is in
// roomId = the Call document id.
const config = require('../config');
const { store } = require('../config/store');
const Call = require('../models/Call');

const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const presence = require('./presence.service');
const emitter = require('../sockets/emitter');
const registry = require('../sockets/registry');
const EVENTS = require('../constants/socketEvents.json');

// Tunables (tests shorten them).
const settings = {
  peerLostGraceMs: config.calls.peerLostGraceSec * 1000,
  maxDurationMs: config.calls.maxDurationMin * 60 * 1000,
  auraPerMinute: config.calls.auraPerMinute,
};

const K = {
  call: (roomId) => `call:${roomId}`,
  ended: (roomId) => `call:${roomId}:ended`,
  userCall: (uid) => `user:${uid}:call`,
};

const maxTimers = new Map(); // roomId -> timeout
const endListeners = new Set(); // (summary, call) => void - e.g. ringing cleanup (Phase 21)
const lostTimers = new Map(); // `${roomId}:${uid}` -> timeout

const ttlSec = () => Math.ceil(settings.maxDurationMs / 1000) + 600;
const roleOf = (call, uid) => (call.callerId === uid ? 'caller' : 'callee');
const peerOf = (call, uid) => (call.callerId === uid ? call.calleeId : call.callerId);

const getCall = async (roomId) => {
  const h = await store.hgetall(K.call(roomId));
  return h && h.callerId ? { roomId, ...h } : null;
};

// Only the two people of a live call may signal in it (17.3).
const assertParticipant = async (roomId, uid) => {
  const call = await getCall(roomId);
  if (!call || (call.callerId !== uid && call.calleeId !== uid)) {
    throw ApiError.forbidden('You are not in this call', 'NOT_IN_CALL');
  }
  return call;
};

// Called when a call is created: random match (both already accepted) or a direct call that
// still has to be answered (awaitingAnswer, Phase 21/22).
const registerCall = async ({ roomId, callerId, calleeId, mode, awaitingAnswer = false }) => {
  const now = Date.now();
  const fields = { callerId, calleeId, mode, state: 'ringing', createdAt: now };
  if (awaitingAnswer) fields.awaitingAnswer = '1';
  await store
    .multi()
    .hset(K.call(roomId), fields)
    .expire(K.call(roomId), ttlSec())
    .set(K.userCall(callerId), roomId, 'EX', ttlSec())
    .set(K.userCall(calleeId), roomId, 'EX', ttlSec())
    .exec();
  // 17.14 safety limit
  const timer = setTimeout(() => {
    endCall(roomId, { reason: 'max_duration' }).catch(() => {});
  }, settings.maxDurationMs);
  if (timer.unref) timer.unref();
  maxTimers.set(roomId, timer);
  logger.info({ roomId, callerId, calleeId, mode }, 'Call registered'); // 17.18
};

// The first signaling from a participant binds that device; signaling to them goes only there
// (their other devices must not answer the same call). Re-bound after a reconnect.
const bindSocket = async (call, uid, socketId) => {
  const field = `${roleOf(call, uid)}Sock`;
  if (call[field] === socketId) return;
  if (!call[field]) await store.hsetnx(K.call(call.roomId), field, socketId);
};

// Relays an event to the other participant's bound device (or all their devices before binding).
const relay = (call, fromUid, event, payload) => {
  const peer = peerOf(call, fromUid);
  const peerSock = call[`${roleOf(call, peer)}Sock`];
  const body = { roomId: call.roomId, from: fromUid, ...payload };
  if (peerSock) emitter.emitToSocket(peerSock, event, body);
  else emitter.emitToUser(peer, event, body);
};

// Both apps report call:connected when ICE connects; the first report starts the clock.
const markConnected = async (roomId) => {
  const now = Date.now();
  const first = await store.hsetnx(K.call(roomId), 'startedAt', now);
  if (first) {
    await store.hset(K.call(roomId), 'state', 'active');
    await Call.updateOne({ _id: roomId }, { $set: { status: 'active', startedAt: new Date(now) } });
    logger.info({ roomId }, 'Call connected');
    return now;
  }
  return Number(await store.hget(K.call(roomId), 'startedAt'));
};

const clearTimers = (roomId) => {
  clearTimeout(maxTimers.get(roomId));
  maxTimers.delete(roomId);
  [...lostTimers.keys()]
    .filter((k) => k.startsWith(`${roomId}:`))
    .forEach((k) => {
      clearTimeout(lostTimers.get(k));
      lostTimers.delete(k);
    });
};

// Ends a call exactly once (17.8 / 17.15 / 17.16). reason: hangup | peer_lost | max_duration |
// blocked | declined | cancelled ... Returns the summary, or null if it was already ended.
const endCall = async (roomId, { reason = 'hangup', endedBy = null } = {}) => {
  const first = await store.set(K.ended(roomId), reason, 'EX', 300, 'NX');
  if (!first) return null;
  clearTimers(roomId);
  const call = await getCall(roomId);
  if (!call) return null;

  const now = Date.now();
  const startedAt = Number(call.startedAt) || null;
  const durationSec = startedAt
    ? Math.min(Math.floor((now - startedAt) / 1000), Math.floor(settings.maxDurationMs / 1000))
    : 0;
  const auraEarned = Math.floor(durationSec / 60) * settings.auraPerMinute;
  // a direct call that rang and was never answered is a missed call for the callee
  const unanswered = call.awaitingAnswer === '1';
  let status = 'cancelled';
  if (startedAt) status = 'ended';
  else if (reason === 'declined') status = 'declined';
  else if (unanswered) status = 'missed';

  await Call.updateOne(
    { _id: roomId },
    { $set: { status, endedAt: new Date(now), durationSec, endReason: reason, auraEarned } },
  );
  // Phase 32: aura (+ weekly board), streak and goal progress for both (lazy: require cycle)
  if (startedAt) {
    const gamification = require('./gamification.service');
    await gamification.addAura([call.callerId, call.calleeId], auraEarned, 'call');
    await gamification.recordConversation([call.callerId, call.calleeId], durationSec);
  }
  await store.del(K.call(roomId));
  await Promise.all(
    [call.callerId, call.calleeId].map(async (uid) => {
      // only clear the pointer if it still points at this call
      if ((await store.get(K.userCall(uid))) === roomId) await store.del(K.userCall(uid));
      await presence.clearBusy(uid); // back to available (fixes "stuck in_call")
    }),
  );

  const summary = { roomId, durationSec, auraEarned, endReason: reason, endedBy, status };
  emitter.emitToUsers([call.callerId, call.calleeId], EVENTS.CALL_ENDED, summary);
  logger.info({ roomId, reason, durationSec, auraEarned, endedBy }, 'Call ended'); // 17.18
  endListeners.forEach((fn) => {
    Promise.resolve()
      .then(() => fn(summary, call))
      .catch((err) => logger.error({ err, roomId }, 'call end listener failed'));
  });
  return summary;
};

// 17.9 last device of a participant went away: tell the peer, wait for a reconnect.
const onUserGone = async (uid) => {
  const roomId = await store.get(K.userCall(uid));
  if (!roomId) return;
  const call = await getCall(roomId);
  if (!call) return;
  // a ringing callee may well be offline (app killed) - the ring timeout handles that
  if (call.awaitingAnswer === '1' && roleOf(call, uid) === 'callee') return;
  // flag in the store so a reconnect on any instance knows this user really dropped
  await store.hset(K.call(roomId), `${roleOf(call, uid)}Lost`, '1');
  emitter.emitToUser(peerOf(call, uid), EVENTS.CALL_PEER_STATUS, {
    roomId,
    status: 'reconnecting',
  });
  const key = `${roomId}:${uid}`;
  clearTimeout(lostTimers.get(key));
  const timer = setTimeout(async () => {
    lostTimers.delete(key);
    try {
      if ((await registry.socketCount(uid)) > 0) return; // back on another instance
      await endCall(roomId, { reason: 'peer_lost', endedBy: uid });
    } catch (err) {
      logger.error({ err, roomId }, 'peer_lost end failed');
    }
  }, settings.peerLostGraceMs);
  if (timer.unref) timer.unref();
  lostTimers.set(key, timer);
};

// A participant who had dropped reconnected: cancel the grace timer, unbind the dead device,
// tell the peer.
// Only after a real drop: a connection from an extra device while the call device is still
// online must not steal the call.
const onUserBack = async (uid) => {
  const roomId = await store.get(K.userCall(uid));
  if (!roomId) return null;
  const call = await getCall(roomId);
  if (!call) return null;
  const role = roleOf(call, uid);
  if (!call[`${role}Lost`]) return null;
  const key = `${roomId}:${uid}`;
  clearTimeout(lostTimers.get(key));
  lostTimers.delete(key);
  await store.hdel(K.call(roomId), `${role}Sock`, `${role}Lost`);
  emitter.emitToUser(peerOf(call, uid), EVENTS.CALL_PEER_STATUS, { roomId, status: 'connected' });
  return roomId;
};

// Phase 26.8: blocking someone ends any live call between the two.
const endCallBetween = async (a, b, reason = 'blocked') => {
  const roomId = await store.get(K.userCall(String(a)));
  if (!roomId) return null;
  const call = await getCall(roomId);
  if (!call || peerOf(call, String(a)) !== String(b)) return null;
  return endCall(roomId, { reason, endedBy: String(a) });
};

const activeCallOf = (uid) => store.get(K.userCall(uid));

// 22.6 / 22.7 reserve both users for a new direct call (SET NX), so two calls can't grab the same
// person at once. Returns 'ok' | 'caller_busy' | 'callee_busy'. registerCall() then overwrites the
// placeholder with the real roomId; releaseCallSlots() undoes it if creating the call fails.
const PENDING = 'pending';
const claimCallSlots = async (callerId, calleeId) => {
  const ttl = 120;
  if (!(await store.set(K.userCall(callerId), PENDING, 'EX', ttl, 'NX'))) return 'caller_busy';
  if (!(await store.set(K.userCall(calleeId), PENDING, 'EX', ttl, 'NX'))) {
    await store.del(K.userCall(callerId));
    return 'callee_busy';
  }
  return 'ok';
};

const releaseCallSlots = async (...uids) => {
  await Promise.all(
    uids.map(async (uid) => {
      if ((await store.get(K.userCall(uid))) === PENDING) await store.del(K.userCall(uid));
    }),
  );
};

// The callee answered: normal call rules (peer-lost etc.) apply from now on.
const markAnswered = (roomId) => store.hdel(K.call(roomId), 'awaitingAnswer');

const onCallEnded = (fn) => {
  endListeners.add(fn);
  return () => endListeners.delete(fn);
};

const __resetForTests = () => {
  [...maxTimers.keys()].forEach(clearTimers);
  lostTimers.forEach((t) => clearTimeout(t));
  lostTimers.clear();
};

module.exports = {
  settings,
  keys: K,
  getCall,
  assertParticipant,
  registerCall,
  bindSocket,
  relay,
  markConnected,
  endCall,
  onUserGone,
  onUserBack,
  endCallBetween,
  activeCallOf,
  markAnswered,
  onCallEnded,
  claimCallSlots,
  releaseCallSlots,
  peerOf,
  __resetForTests,
};
