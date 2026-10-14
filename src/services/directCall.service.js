// Direct calls (Phase 22): call someone by private number / "Call again" / profile.
// Checks, then hands over to ringing.service (Phase 21) which reaches the callee.
//
// Order of checks (first failure wins):
//   callee exists + set up, not me, no block either way  -> else 404 USER_NOT_FOUND (a block is
//                                                            never revealed)
//   callee's "who can call me" (everyone / past_matches / nobody) -> 403 CALLS_NOT_ALLOWED
//   rate limit DIRECT_CALLS_PER_HOUR per caller          -> 429 RATE_LIMITED
//   caller already in a call / search / chat             -> 409 BUSY
//   callee in a call / chat (or another call is ringing)  -> 409 USER_BUSY
const mongoose = require('mongoose');
const { redis } = require('../config/redis');
const Call = require('../models/Call');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { toPublicUser } = require('../utils/serializers');
const { DIRECT_CALLS_PER_HOUR } = require('../constants/appConfig');
const { isBlockedEitherWay } = require('./block.service');
const presence = require('./presence.service');
const callSession = require('./callSession.service');
const ringing = require('./ringing.service');

const settings = { perHour: DIRECT_CALLS_PER_HOUR };
const BUSY_STATES = [presence.STATE.IN_CALL, presence.STATE.IN_CHAT];

const notFound = () => ApiError.notFound('User not found', 'USER_NOT_FOUND');

// "Only past matches" = we talked before (a call between us that connected).
const havePastCall = (a, b) =>
  Call.exists({
    $or: [
      { callerId: a, calleeId: b },
      { callerId: b, calleeId: a },
    ],
    startedAt: { $exists: true },
  });

const checkPrivacy = async (callee, callerId) => {
  const rule = (callee.settings && callee.settings.directCalls) || 'everyone';
  if (rule === 'everyone') return;
  if (rule === 'past_matches' && (await havePastCall(callerId, callee._id))) return;
  throw ApiError.forbidden(
    `${callee.name} only takes calls from people they have talked to`,
    'CALLS_NOT_ALLOWED',
  );
};

const checkRateLimit = async (callerId) => {
  const key = `rl:direct:${callerId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  if (count > settings.perHour) {
    throw ApiError.tooMany('Too many calls. Try again later.', 'RATE_LIMITED', {
      retryAfterSec: await redis.ttl(key),
    });
  }
};

const startDirectCall = async (caller, { calleeId, mode = 'audio' }) => {
  const callerId = String(caller._id);
  if (!mongoose.isValidObjectId(calleeId)) throw notFound();
  if (String(calleeId) === callerId) {
    throw ApiError.badRequest("You can't call yourself", 'CANNOT_CALL_SELF');
  }
  const callee = await User.findOne({ _id: calleeId, status: 'active' });
  if (!callee || !callee.name || !callee.gender) throw notFound();
  if (await isBlockedEitherWay(callerId, callee._id)) throw notFound();
  await checkPrivacy(callee, callerId);
  await checkRateLimit(callerId);

  const [mine, theirs] = await Promise.all([
    presence.getPresence(callerId),
    presence.getPresence(String(callee._id)),
  ]);
  if ([...BUSY_STATES, presence.STATE.SEARCHING].includes(mine.state)) {
    throw ApiError.conflict('Finish your current call or search first', 'BUSY');
  }
  if (BUSY_STATES.includes(theirs.state)) {
    throw ApiError.conflict(`${callee.name} is on another call`, 'USER_BUSY');
  }
  const slots = await callSession.claimCallSlots(callerId, String(callee._id));
  if (slots === 'caller_busy') {
    throw ApiError.conflict('Finish your current call first', 'BUSY');
  }
  if (slots === 'callee_busy') {
    throw ApiError.conflict(`${callee.name} is on another call`, 'USER_BUSY');
  }

  try {
    const call = await Call.create({
      callerId,
      calleeId: callee._id,
      mode,
      matchType: 'direct', // 22.15
      status: 'ringing',
    });
    const roomId = String(call._id);
    const ring = await ringing.startRinging({ roomId, caller, calleeId: String(callee._id), mode });
    logger.info({ roomId, callerId, calleeId: String(callee._id) }, 'Direct call started');
    return { ...ring, callId: roomId, mode, peer: toPublicUser(callee) };
  } catch (err) {
    await callSession.releaseCallSlots(callerId, String(callee._id));
    throw err;
  }
};

module.exports = { settings, startDirectCall };
