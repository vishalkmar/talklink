// Ringing a direct call (Phase 21): reach the callee over the socket and/or a high-priority push,
// let one of their devices answer, and turn unanswered calls into missed calls.
// Phase 22's POST /calls/direct creates the Call document and calls startRinging().
//
// Store:
//   ring:<roomId>       HASH { callerId, calleeId, mode, caller (JSON), expiresAt }  TTL ring + 60 s
//   ring:<roomId>:done  STRING (SET NX) accepted | declined | missed | cancelled - one outcome wins
//
// Flow: startRinging -> call:incoming (socket) + incoming_call (push) -> call:ringing to the caller
//   accept  (call:accept)                -> caller gets call:accept, WebRTC starts (Phase 19 flow)
//   decline (call:decline / REST)        -> endCall(declined)
//   no answer in RING_TIMEOUT_SEC        -> endCall(no_answer) -> status missed
//   caller hangs up while ringing        -> endCall(hangup)    -> status missed
// Whenever ringing stops, every callee device gets call:ring-stopped and the push device gets
// call_cancelled (removes the full-screen notification); missed calls also get missed_call.
const config = require('../config');
const { store } = require('../config/store');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { toPublicUser } = require('../utils/serializers');
const callSession = require('./callSession.service');
const presence = require('./presence.service');
const push = require('./push.service');
const emitter = require('../sockets/emitter');
const registry = require('../sockets/registry');
const EVENTS = require('../constants/socketEvents.json');

const settings = { ringTimeoutMs: config.calls.ringTimeoutSec * 1000 };

const K = {
  ring: (roomId) => `ring:${roomId}`,
  done: (roomId) => `ring:${roomId}:done`,
};

const timers = new Map(); // roomId -> timeout (instance that started the ring)

const callerInfo = (u) => {
  const p = toPublicUser(u);
  return {
    id: p.id,
    name: p.name,
    gender: p.gender,
    avatar: p.avatar,
    privateNumber: p.privateNumber,
  };
};

const getRing = async (roomId) => {
  const r = await store.hgetall(K.ring(roomId));
  if (!r || !r.calleeId) return null;
  return { ...r, roomId, expiresAt: Number(r.expiresAt), caller: JSON.parse(r.caller || '{}') };
};

const incomingPayload = (ring) => ({
  roomId: ring.roomId,
  mode: ring.mode,
  caller: ring.caller,
  expiresAt: ring.expiresAt,
});

const clearTimer = (roomId) => {
  clearTimeout(timers.get(roomId));
  timers.delete(roomId);
};

// Claims the single outcome of this ring. false = something else already happened.
const claim = async (roomId, outcome) =>
  Boolean(await store.set(K.done(roomId), outcome, 'EX', 600, 'NX'));

// Stop the ringing on all callee devices (socket) and on the push device.
const stopRinging = async (ring, reason) => {
  clearTimer(ring.roomId);
  await store.del(K.ring(ring.roomId));
  emitter.emitToUser(ring.calleeId, EVENTS.CALL_RING_STOPPED, { roomId: ring.roomId, reason });
  await push.sendToUser(ring.calleeId, push.PUSH.CALL_CANCELLED, { roomId: ring.roomId, reason });
};

// 21.4 / 22.6
const startRinging = async ({ roomId, caller, calleeId, mode = 'audio' }) => {
  const callerId = String(caller._id || caller.id);
  const expiresAt = Date.now() + settings.ringTimeoutMs;
  const info = callerInfo(caller);
  await callSession.registerCall({
    roomId,
    callerId,
    calleeId: String(calleeId),
    mode,
    awaitingAnswer: true,
  });
  await store
    .multi()
    .hset(K.ring(roomId), {
      callerId,
      calleeId: String(calleeId),
      mode,
      caller: JSON.stringify(info),
      expiresAt,
    })
    .expire(K.ring(roomId), Math.ceil(settings.ringTimeoutMs / 1000) + 60)
    .exec();
  await presence.setBusy(callerId, presence.STATE.IN_CALL);

  const ring = { roomId, callerId, calleeId: String(calleeId), mode, caller: info, expiresAt };
  const online = (await registry.socketCount(ring.calleeId)) > 0;
  if (online) emitter.emitToUser(ring.calleeId, EVENTS.CALL_INCOMING, incomingPayload(ring));
  // the push goes out even when a socket is open: a backgrounded app may not show socket events,
  // and the app ignores a second ring for the same roomId
  const pushed = await push.sendToUser(
    ring.calleeId,
    push.PUSH.INCOMING_CALL,
    {
      roomId,
      mode,
      callerId,
      callerName: info.name,
      callerAvatar: info.avatar,
      expiresAt,
    },
    { ttlSec: Math.ceil(settings.ringTimeoutMs / 1000) },
  );
  let delivered = 'none';
  if (online) delivered = 'socket';
  else if (pushed.sent) delivered = 'push';
  emitter.emitToUser(callerId, EVENTS.CALL_RINGING, { roomId, expiresAt, delivered });

  // 21.13 not answered in time -> missed call
  const timer = setTimeout(async () => {
    timers.delete(roomId);
    try {
      if (!(await claim(roomId, 'missed'))) return; // answered / declined at the last moment
      await callSession.endCall(roomId, { reason: 'no_answer' });
    } catch (err) {
      logger.error({ err, roomId }, 'ring timeout end failed');
    }
  }, settings.ringTimeoutMs);
  if (timer.unref) timer.unref();
  timers.set(roomId, timer);

  logger.info({ roomId, callerId, calleeId: ring.calleeId, delivered }, 'Ringing');
  return { roomId, expiresAt, delivered };
};

const assertCallee = (ring, uid) => {
  if (!ring) throw ApiError.notFound('This call has ended', 'CALL_NOT_RINGING');
  if (ring.calleeId !== String(uid))
    throw ApiError.forbidden('You are not in this call', 'NOT_IN_CALL');
};

// 21.9 one of the callee's devices answers
const acceptCall = async (roomId, uid, socketId) => {
  const ring = await getRing(roomId);
  assertCallee(ring, uid);
  if (!(await claim(roomId, 'accepted'))) {
    throw ApiError.conflict('This call was already answered or ended', 'CALL_NOT_RINGING');
  }
  clearTimer(roomId);
  if (!(await callSession.getCall(roomId))) {
    throw ApiError.notFound('This call has ended', 'CALL_NOT_RINGING'); // caller hung up just now
  }
  await callSession.markAnswered(roomId);
  if (socketId) await store.hsetnx(callSession.keys.call(roomId), 'calleeSock', socketId);
  await presence.setBusy(String(uid), presence.STATE.IN_CALL);

  const callee = await User.findById(uid).lean();
  const peerForCaller = callee ? callerInfo(callee) : { id: String(uid) };
  emitter.emitToUser(ring.callerId, EVENTS.CALL_ACCEPT, {
    roomId,
    mode: ring.mode,
    role: 'caller',
    peer: peerForCaller,
  });
  await stopRinging(ring, 'answered'); // other devices of the callee stop ringing
  logger.info({ roomId, calleeId: String(uid) }, 'Call answered');
  return { roomId, mode: ring.mode, role: 'callee', peer: ring.caller };
};

// 21.10 decline from the app or straight from the notification (REST)
const declineCall = async (roomId, uid) => {
  const ring = await getRing(roomId);
  assertCallee(ring, uid);
  if (!(await claim(roomId, 'declined'))) return { declined: false, alreadyEnded: true };
  clearTimer(roomId);
  await callSession.endCall(roomId, { reason: 'declined', endedBy: String(uid) });
  return { declined: true };
};

// After every endCall: if this call was still ringing, stop the ring and (if unanswered) send the
// missed-call notification. Covers timeout, caller hang-up, caller lost, block, decline.
callSession.onCallEnded(async (summary, call) => {
  const ring = await getRing(summary.roomId);
  if (!ring) return;
  await claim(summary.roomId, summary.status === 'declined' ? 'declined' : 'missed');
  await stopRinging(ring, summary.status === 'declined' ? 'declined' : 'cancelled');
  if (summary.status === 'missed') {
    await push.sendToUser(call.calleeId, push.PUSH.MISSED_CALL, {
      roomId: summary.roomId,
      callerId: ring.callerId,
      callerName: ring.caller.name,
      callerAvatar: ring.caller.avatar,
    });
  }
});

// A callee device that connects while a call is ringing for them (e.g. the app was opened from
// the push) gets the ring again.
const resendPending = async (uid, socketId) => {
  const roomId = await callSession.activeCallOf(uid);
  if (!roomId) return false;
  const ring = await getRing(roomId);
  if (!ring || ring.calleeId !== String(uid) || ring.expiresAt <= Date.now()) return false;
  emitter.emitToSocket(socketId, EVENTS.CALL_INCOMING, incomingPayload(ring));
  return true;
};

const __resetForTests = () => {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
};

module.exports = {
  settings,
  keys: K,
  startRinging,
  acceptCall,
  declineCall,
  resendPending,
  getRing,
  __resetForTests,
};
