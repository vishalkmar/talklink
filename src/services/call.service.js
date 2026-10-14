// Call history (Phase 12). Live call signaling arrives in Phase 17.
const mongoose = require('mongoose');
const Call = require('../models/Call');
const User = require('../models/User');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const { toPublicUser } = require('../utils/serializers');

const { ObjectId } = mongoose.Types;
const DEFAULT_LIMIT = 20;

// Opaque cursor = base64url({ t: createdAt, id }) of the last item on the previous page.
const encodeCursor = (call) =>
  Buffer.from(JSON.stringify({ t: call.createdAt.toISOString(), id: String(call._id) })).toString(
    'base64url',
  );

const decodeCursor = (cursor) => {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const date = new Date(t);
    if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) throw new Error('bad');
    return { date, id: new ObjectId(id) };
  } catch {
    throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
  }
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ids of users whose name or private number matches the search text.
const usersMatching = async (q) => {
  const text = q.trim();
  const digits = text.replace(/^#/, '');
  const or = [{ name: { $regex: escapeRegex(text), $options: 'i' } }];
  if (/^\d{1,6}$/.test(digits)) or.push({ privateNumber: { $regex: `^${digits}` } });
  const users = await User.find({ $or: or }).select('_id').limit(500).lean();
  return users.map((u) => u._id);
};

const directionFor = (call, uid) => {
  if (call.callerId.equals(uid)) return 'outgoing';
  return call.status === 'missed' ? 'missed' : 'incoming';
};

// filter: all | audio | text | missed ; q: name or private number ; cursor from previous page.
const listHistory = async (userId, { cursor, limit = DEFAULT_LIMIT, filter = 'all', q } = {}) => {
  const uid = new ObjectId(String(userId));
  const and = [{ $or: [{ callerId: uid }, { calleeId: uid }] }, { hiddenFor: { $ne: uid } }];

  if (filter === 'audio' || filter === 'text') and.push({ mode: filter });
  if (filter === 'missed') and.push({ calleeId: uid, status: 'missed' });

  if (q && q.trim()) {
    const ids = await usersMatching(q);
    if (!ids.length) return { items: [], nextCursor: null };
    and.push({
      $or: [
        { callerId: uid, calleeId: { $in: ids } },
        { calleeId: uid, callerId: { $in: ids } },
      ],
    });
  }

  if (cursor) {
    const c = decodeCursor(cursor);
    and.push({ $or: [{ createdAt: { $lt: c.date } }, { createdAt: c.date, _id: { $lt: c.id } }] });
  }

  const calls = await Call.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = calls.length > limit;
  const page = hasMore ? calls.slice(0, limit) : calls;

  const otherIds = [
    ...new Set(page.map((c) => String(c.callerId.equals(uid) ? c.calleeId : c.callerId))),
  ];
  const [users, myBlocks] = await Promise.all([
    User.find({ _id: { $in: otherIds } }).lean(),
    Block.find({ blockerId: uid, blockedId: { $in: otherIds } })
      .select('blockedId')
      .lean(),
  ]);
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  // Only blocks *I* made are shown (greyed). A block by the other person is never revealed.
  const blockedByMe = new Set(myBlocks.map((b) => String(b.blockedId)));

  const items = page.map((c) => {
    const otherId = String(c.callerId.equals(uid) ? c.calleeId : c.callerId);
    const other = usersById.get(otherId);
    const available = other && other.status === 'active';
    return {
      id: String(c._id),
      direction: directionFor(c, uid),
      mode: c.mode,
      matchType: c.matchType,
      status: c.status,
      durationSec: c.durationSec || 0,
      auraEarned: c.auraEarned || 0,
      startedAt: c.startedAt || null,
      endedAt: c.endedAt || null,
      createdAt: c.createdAt,
      isBlocked: blockedByMe.has(otherId),
      user: available ? toPublicUser(other) : { id: otherId, name: null, deleted: true },
    };
  });

  return { items, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
};

// "Delete from history" only hides the call for me (12.9); the other person keeps it.
const hideCall = async (userId, callId) => {
  if (!mongoose.isValidObjectId(callId))
    throw ApiError.notFound('Call not found', 'CALL_NOT_FOUND');
  const uid = new ObjectId(String(userId));
  const res = await Call.updateOne(
    { _id: callId, $or: [{ callerId: uid }, { calleeId: uid }] },
    { $addToSet: { hiddenFor: uid } },
  );
  if (!res.matchedCount) throw ApiError.notFound('Call not found', 'CALL_NOT_FOUND');
};

// 20.10 Rate a finished call (1-5 stars), once per participant. Only calls that connected.
const rateCall = async (userId, callId, stars) => {
  if (!mongoose.isValidObjectId(callId))
    throw ApiError.notFound('Call not found', 'CALL_NOT_FOUND');
  const uid = new ObjectId(String(userId));
  const mine = { _id: callId, $or: [{ callerId: uid }, { calleeId: uid }] };
  const res = await Call.updateOne(
    { ...mine, status: 'ended', durationSec: { $gt: 0 }, 'ratings.userId': { $ne: uid } },
    { $push: { ratings: { userId: uid, stars, createdAt: new Date() } } },
  );
  if (res.modifiedCount) {
    // 32.5 a good rating gives the other person aura
    if (stars >= 4) {
      const call = await Call.findById(callId).select('callerId calleeId').lean();
      const other = call.callerId.equals(uid) ? call.calleeId : call.callerId;
      const gamification = require('./gamification.service');
      await gamification.addAura(other, gamification.settings.auraPerGoodRating, 'good_rating');
    }
    return { rated: true, stars };
  }

  const call = await Call.findOne(mine).select('status durationSec ratings').lean();
  if (!call) throw ApiError.notFound('Call not found', 'CALL_NOT_FOUND');
  if ((call.ratings || []).some((r) => r.userId.equals(uid)))
    throw ApiError.conflict('You already rated this call', 'ALREADY_RATED');
  throw ApiError.conflict('Only finished calls can be rated', 'CALL_NOT_RATABLE');
};

module.exports = { listHistory, hideCall, rateCall, encodeCursor, decodeCursor, DEFAULT_LIMIT };
