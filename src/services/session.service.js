// Random text sessions (Phase 25): a text match opens a temporary chat with a stranger.
//
// Lifecycle (docs/DECISIONS.md ADR-030):
//   match:found (mode text) -> createSession(): Conversation { isRandomSession: true } + Redis state
//   messages go through chat.service like any chat; each message resets the idle timer
//   end:   session:end / session:next / 5 min without messages / last device gone > 60 s / block
//          -> "Stranger left the chat" system message, input closed, Call (mode text) gets the
//             duration + aura, chat deleted 24 h later (TTL)
//   save:  both press "Add to chats" -> the session becomes a permanent chat (or merges into the
//          one they already have) and is never deleted
//
// Redis:
//   session:<convId>        HASH { callId, a, b, startedAt, connectWithA, addA, addB }
//   session:<convId>:ended  STRING (SET NX) - ends exactly once, on any instance
//   user:<uid>:session      STRING convId
const config = require('../config');
const { redis } = require('../config/redis');
const Call = require('../models/Call');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const presence = require('./presence.service');
const chat = require('./chat.service');
const emitter = require('../sockets/emitter');
const registry = require('../sockets/registry');
const EVENTS = require('../constants/socketEvents.json');

const settings = {
  idleMs: 5 * 60 * 1000, // 25.13
  backgroundGraceMs: 60 * 1000, // 25.14
  safetyWindowMs: 2 * 60 * 1000, // 25.12 no phone numbers in the first 2 minutes
  auraPerMinute: config.calls.auraPerMinute, // 25.10 same rate as calls
};

const K = {
  session: (id) => `session:${id}`,
  ended: (id) => `session:${id}:ended`,
  user: (uid) => `user:${uid}:session`,
};
const TTL_SEC = 6 * 3600;

const idleTimers = new Map(); // convId -> timeout
const goneTimers = new Map(); // uid -> timeout

const END_TEXT = {
  ended: 'Stranger left the chat',
  next: 'Stranger left the chat',
  left: 'Stranger left the chat',
  idle: 'Chat ended after 5 minutes without messages',
  blocked: 'Chat ended',
};

const getSession = async (convId) => {
  const h = await redis.hgetall(K.session(convId));
  return h && h.a ? { ...h, convId } : null;
};

const roleOf = (s, uid) => (s.a === String(uid) ? 'A' : 'B');
const peerOf = (s, uid) => (s.a === String(uid) ? s.b : s.a);

const assertMember = async (convId, uid) => {
  const s = await getSession(String(convId));
  if (!s || (s.a !== String(uid) && s.b !== String(uid))) {
    throw ApiError.notFound('This chat has ended', 'SESSION_NOT_FOUND');
  }
  return s;
};

const armIdle = (convId) => {
  clearTimeout(idleTimers.get(convId));
  const t = setTimeout(() => {
    idleTimers.delete(convId);
    endSession(convId, { reason: 'idle' }).catch((err) =>
      logger.error({ err, convId }, 'session idle end failed'),
    );
  }, settings.idleMs);
  if (t.unref) t.unref();
  idleTimers.set(convId, t);
};

// 25.2 called by match.service when a text match is made
const createSession = async ({ callId, callerId, calleeId, connectWith = 'anyone' }) => {
  const a = String(callerId);
  const b = String(calleeId);
  const conv = await Conversation.create({
    participants: [a, b],
    participantsKey: Conversation.keyFor(a, b),
    isRandomSession: true,
  });
  const convId = String(conv._id);
  await Call.updateOne({ _id: callId }, { $set: { conversationId: conv._id } });
  await redis
    .multi()
    .hset(K.session(convId), {
      callId: String(callId),
      a,
      b,
      startedAt: Date.now(),
      connectWithA: connectWith,
    })
    .expire(K.session(convId), TTL_SEC)
    .set(K.user(a), convId, 'EX', TTL_SEC)
    .set(K.user(b), convId, 'EX', TTL_SEC)
    .exec();
  armIdle(convId);
  logger.info({ convId, callId: String(callId), a, b }, 'Text session started');
  return convId;
};

// every message in a session (chat.service)
const touch = async (convId) => {
  if (idleTimers.has(String(convId)) || (await getSession(String(convId)))) armIdle(String(convId));
};

// 25.12 phone numbers are not allowed in the first minutes with a stranger
const PHONE = /(\+?91[\s-]?)?[6-9](\D?\d){9}\b|\b\d{10,}\b/;
const checkSafety = (conv, text) => {
  if (!conv.isRandomSession) return;
  const age = Date.now() - new Date(conv.createdAt).getTime();
  if (age < settings.safetyWindowMs && PHONE.test(text)) {
    throw ApiError.badRequest('Phone numbers can be shared after 2 minutes', 'PHONE_NOT_ALLOWED');
  }
};

const cleanupKeys = async (s) => {
  clearTimeout(idleTimers.get(s.convId));
  idleTimers.delete(s.convId);
  await redis.del(K.session(s.convId));
  await Promise.all(
    [s.a, s.b].map(async (uid) => {
      if ((await redis.get(K.user(uid))) === s.convId) await redis.del(K.user(uid));
    }),
  );
};

const finishCall = async (s, reason) => {
  const now = Date.now();
  const durationSec = Math.max(0, Math.floor((now - Number(s.startedAt)) / 1000));
  const auraEarned = Math.floor(durationSec / 60) * settings.auraPerMinute;
  await Call.updateOne(
    { _id: s.callId },
    {
      $set: { status: 'ended', endedAt: new Date(now), durationSec, endReason: reason, auraEarned },
    },
  );
  // Phase 32: aura (+ weekly board), streak and goal progress for both
  const gamification = require('./gamification.service');
  await gamification.addAura([s.a, s.b], auraEarned, 'text_session');
  await gamification.recordConversation([s.a, s.b], durationSec);
  await Promise.all([presence.clearBusy(s.a), presence.clearBusy(s.b)]);
  return { durationSec, auraEarned };
};

// 25.5 / 25.6 ends once; returns the summary or null if it had already ended
const endSession = async (convId, { reason = 'ended', endedBy = null } = {}) => {
  const id = String(convId);
  if (!(await redis.set(K.ended(id), reason, 'EX', 600, 'NX'))) return null;
  const s = await getSession(id);
  if (!s) return null;
  await cleanupKeys(s);
  const { durationSec, auraEarned } = await finishCall(s, reason);

  const system = await Message.create({
    conversationId: id,
    senderId: null,
    type: 'system',
    text: END_TEXT[reason] || END_TEXT.ended,
  });
  await chat.scheduleEphemeralDelete(id, new Date()); // 25.8 gone after 24 h unless saved

  const payload = {
    conversationId: id,
    reason,
    endedBy: endedBy ? String(endedBy) : null,
    durationSec,
    auraEarned,
    systemMessage: chat.toMessage(system),
  };
  emitter.emitToUsers([s.a, s.b], EVENTS.SESSION_ENDED, payload);
  logger.info({ convId: id, reason, durationSec }, 'Text session ended');
  return payload;
};

// 25.4 end and look for the next stranger straight away
const nextSession = async (uid, convId) => {
  // 25.18 a double tap must not start two searches / end twice
  if (!(await redis.set(`session:next:${uid}`, '1', 'PX', 3000, 'NX'))) {
    throw ApiError.conflict('Already looking for the next person', 'ALREADY_SEARCHING');
  }
  const s = await assertMember(convId, uid);
  const connectWith = s.a === String(uid) ? s.connectWithA || 'anyone' : 'anyone';
  await endSession(convId, { reason: 'next', endedBy: uid });
  // required here: match.service creates sessions, so a top-level require would be a cycle
  const match = require('./match.service');
  return match.requestMatch(String(uid), { mode: 'text', connectWith });
};

// both said yes: keep the chat for good
const convert = async (s) => {
  const id = s.convId;
  const existing = await Conversation.findOne({
    participantsKey: Conversation.keyFor(s.a, s.b),
    isRandomSession: false,
  });
  let permanentId = id;
  if (existing) {
    // they already had a chat: move the session messages into it
    await Message.updateMany({ conversationId: id }, { $set: { conversationId: existing._id } });
    const last = await Message.findOne({ conversationId: existing._id, type: 'text' })
      .sort({ createdAt: -1 })
      .lean();
    if (last) {
      await Conversation.updateOne(
        { _id: existing._id },
        {
          $set: {
            lastMessage: { text: last.text, senderId: last.senderId, createdAt: last.createdAt },
          },
          $pull: { deletedFor: { $in: [s.a, s.b] } },
        },
      );
    }
    await Conversation.deleteOne({ _id: id });
    permanentId = String(existing._id);
  } else {
    await Conversation.updateOne(
      { _id: id },
      { $set: { isRandomSession: false }, $unset: { expiresAt: 1, endedAt: 1 } },
    );
  }
  await Message.updateMany({ conversationId: permanentId }, { $unset: { expiresAt: 1 } });
  return permanentId;
};

// 25.7 "Add to chats" - both must agree
const requestAdd = async (uid, convId) => {
  const s = await assertMember(convId, uid);
  const role = roleOf(s, uid);
  await redis.hset(K.session(s.convId), `add${role}`, '1');
  const other = role === 'A' ? s.addB : s.addA;
  if (!other) {
    emitter.emitToUser(peerOf(s, uid), EVENTS.SESSION_ADD_REQUEST, { conversationId: s.convId });
    return { added: false, waiting: true };
  }
  // both agreed: this wins the end guard so no "stranger left" ending can run in between
  if (!(await redis.set(K.ended(s.convId), 'saved', 'EX', 600, 'NX'))) {
    throw ApiError.conflict('This chat has ended', 'SESSION_NOT_FOUND');
  }
  await cleanupKeys(s);
  const { durationSec, auraEarned } = await finishCall(s, 'saved');
  const permanentId = await convert(s);
  const payload = {
    sessionId: s.convId,
    conversationId: permanentId,
    durationSec,
    auraEarned,
  };
  emitter.emitToUsers([s.a, s.b], EVENTS.SESSION_ADDED, payload);
  logger.info({ convId: s.convId, permanentId }, 'Text session saved as a chat');
  return { added: true, conversationId: permanentId };
};

// 25.14 last device gone (killed / no network): 60 s to come back
const onUserGone = async (uid) => {
  const convId = await redis.get(K.user(uid));
  if (!convId) return;
  clearTimeout(goneTimers.get(uid));
  const t = setTimeout(async () => {
    goneTimers.delete(uid);
    try {
      if ((await registry.socketCount(uid)) > 0) return;
      await endSession(convId, { reason: 'left', endedBy: uid });
    } catch (err) {
      logger.error({ err, uid }, 'session left end failed');
    }
  }, settings.backgroundGraceMs);
  if (t.unref) t.unref();
  goneTimers.set(uid, t);
};

const onUserBack = (uid) => {
  clearTimeout(goneTimers.get(uid));
  goneTimers.delete(uid);
};

// 25.11 block in a session ends it
const endSessionBetween = async (a, b) => {
  const convId = await redis.get(K.user(String(a)));
  if (!convId) return null;
  const s = await getSession(convId);
  if (!s || peerOf(s, String(a)) !== String(b)) return null;
  return endSession(convId, { reason: 'blocked', endedBy: String(a) });
};

const activeSessionOf = (uid) => redis.get(K.user(String(uid)));

const __resetForTests = () => {
  idleTimers.forEach((t) => clearTimeout(t));
  idleTimers.clear();
  goneTimers.forEach((t) => clearTimeout(t));
  goneTimers.clear();
};

module.exports = {
  settings,
  keys: K,
  createSession,
  touch,
  checkSafety,
  endSession,
  nextSession,
  requestAdd,
  onUserGone,
  onUserBack,
  endSessionBetween,
  activeSessionOf,
  getSession,
  assertMember,
  __resetForTests,
};
