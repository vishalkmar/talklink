// Blocks (Phase 12 block, Phase 24 unblock, Phase 26 list + store cache + side effects).
// A block works both ways: neither side can call, message, match or find the other (26.9).
//
// store cache (26.10): blocks:<uid> = SET of user ids blocked by or blocking <uid>, plus a
// marker member so an empty set is cached too. Rebuilt from Mongo on a miss, dropped for both
// users on every block / unblock.
const mongoose = require('mongoose');
const Block = require('../models/Block');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { store } = require('../config/store');
const { toPublicUser } = require('../utils/serializers');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

const CACHE_TTL_SEC = 3600;
const MARKER = '_';
const cacheKey = (uid) => `blocks:${uid}`;

const notFound = () => ApiError.notFound('User not found', 'USER_NOT_FOUND');

// Everyone this user must never meet (blocked by them or blocking them).
const blockedIdsOf = async (uid) => {
  const key = cacheKey(String(uid));
  const cached = await store.smembers(key);
  if (cached.length) return new Set(cached.filter((id) => id !== MARKER));
  const rows = await Block.find({ $or: [{ blockerId: uid }, { blockedId: uid }] })
    .select('blockerId blockedId')
    .lean();
  const ids = rows.map((b) =>
    String(String(b.blockerId) === String(uid) ? b.blockedId : b.blockerId),
  );
  await store
    .multi()
    .sadd(key, MARKER, ...ids)
    .expire(key, CACHE_TTL_SEC)
    .exec();
  return new Set(ids);
};

const dropCache = (a, b) => store.del(cacheKey(String(a)), cacheKey(String(b)));

// True if either user has blocked the other.
const isBlockedEitherWay = async (userA, userB) =>
  (await blockedIdsOf(String(userA))).has(String(userB));

const hasBlocked = (blockerId, targetId) => Block.exists({ blockerId, blockedId: targetId });

// Idempotent: blocking someone twice is fine. Unknown / deleted users -> 404 (no enumeration).
const blockUser = async (blockerId, targetId) => {
  if (!mongoose.isValidObjectId(targetId)) throw notFound();
  if (String(blockerId) === String(targetId)) {
    throw ApiError.badRequest('You cannot block yourself', 'CANNOT_BLOCK_SELF');
  }
  const target = await User.exists({ _id: targetId, status: { $ne: 'deleted' } });
  if (!target) throw notFound();
  await Block.updateOne(
    { blockerId, blockedId: targetId },
    { $setOnInsert: { blockerId, blockedId: targetId } },
    { upsert: true },
  );
  await dropCache(blockerId, targetId);
  // 26.8 live call / text session between the two end now (lazy: avoids require cycles)
  await require('./callSession.service').endCallBetween(blockerId, targetId, 'blocked');
  await require('./session.service').endSessionBetween(blockerId, targetId);
  // my other devices update their UI (the blocked person is never told)
  emitter.emitToUser(String(blockerId), EVENTS.USER_BLOCKED, {
    userId: String(targetId),
    blocked: true,
  });
  return { blocked: true, userId: String(targetId) };
};

const unblockUser = async (blockerId, targetId) => {
  if (!mongoose.isValidObjectId(targetId)) throw notFound();
  const res = await Block.deleteOne({ blockerId, blockedId: targetId });
  await dropCache(blockerId, targetId);
  if (res.deletedCount) {
    emitter.emitToUser(String(blockerId), EVENTS.USER_BLOCKED, {
      userId: String(targetId),
      blocked: false,
    });
  }
  return { unblocked: res.deletedCount > 0, userId: String(targetId) };
};

// 26.16 people I blocked, newest first
const listBlocked = async (blockerId) => {
  const rows = await Block.find({ blockerId }).sort({ createdAt: -1 }).limit(500).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.blockedId) } }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return {
    items: rows.map((r) => {
      const u = byId.get(String(r.blockedId));
      return {
        user:
          u && u.status !== 'deleted'
            ? toPublicUser(u)
            : { id: String(r.blockedId), name: null, deleted: true },
        blockedAt: r.createdAt,
      };
    }),
  };
};

module.exports = {
  isBlockedEitherWay,
  blockedIdsOf,
  blockUser,
  unblockUser,
  hasBlocked,
  listBlocked,
};
