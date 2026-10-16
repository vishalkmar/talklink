const crypto = require('crypto');
const mongoose = require('mongoose');
const Status = require('../models/Status');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Call = require('../models/Call');
const media = require('./media.service');
const { blockedIdsOf } = require('./block.service');
const { toPublicUser } = require('../utils/serializers');
const ApiError = require('../utils/ApiError');

const DAY_MS = 86400000;
const active = () => ({ state: 'active', expiresAt: { $gt: new Date() } });
const missing = () => ApiError.notFound('Status is unavailable or expired', 'STATUS_NOT_FOUND');
const full = () => ApiError.conflict('You can have up to 3 active statuses', 'STATUS_LIMIT');
const expire = (owner) =>
  Status.updateMany(
    { ...(owner ? { owner } : {}), state: { $ne: 'deleting' }, expiresAt: { $lte: new Date() } },
    {
      $set: { state: 'deleting', viewers: [], caption: '' },
      $unset: { url: 1, durationSec: 1, publishedAt: 1 },
    },
  );

const contacts = async (uid) => {
  const [chats, calls, blocked] = await Promise.all([
    Conversation.find({ participants: uid, 'lastMessage.createdAt': { $exists: true } })
      .select('participants')
      .lean(),
    Call.find({ $or: [{ callerId: uid }, { calleeId: uid }], startedAt: { $ne: null } })
      .select('callerId calleeId')
      .lean(),
    blockedIdsOf(uid),
  ]);
  const ids = new Set([String(uid)]);
  chats.forEach((c) => c.participants.forEach((id) => ids.add(String(id))));
  calls.forEach((c) => {
    ids.add(String(c.callerId));
    ids.add(String(c.calleeId));
  });
  blocked.forEach((id) => ids.delete(id));
  return [...ids];
};

const serialize = (s, uid) => ({
  id: String(s._id),
  ownerId: String(s.owner),
  type: s.resourceType,
  url: s.url,
  durationSec: s.durationSec,
  caption: s.caption,
  createdAt: s.publishedAt,
  expiresAt: s.expiresAt,
  seen: s.viewers.some((v) => String(v.user) === String(uid)),
  ...(String(s.owner) === String(uid) ? { viewCount: s.viewers.length } : {}),
});

const list = async (uid) => {
  const ids = await contacts(uid);
  const users = await User.find({ _id: { $in: ids }, status: 'active' }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const rows = await Status.find({ ...active(), owner: { $in: users.map((u) => u._id) } })
    .sort({ publishedAt: 1 })
    .lean();
  const groups = new Map();
  rows.forEach((s) => {
    const id = String(s.owner);
    if (!groups.has(id)) groups.set(id, { owner: toPublicUser(byId.get(id)), items: [] });
    groups.get(id).items.push(serialize(s, uid));
  });
  const items = [...groups.values()].filter((g) => g.owner.id !== String(uid));
  items.sort(
    (a, b) =>
      Number(b.items.some((s) => !s.seen)) - Number(a.items.some((s) => !s.seen)) ||
      new Date(b.items.at(-1).createdAt) - new Date(a.items.at(-1).createdAt),
  );
  return {
    mine: groups.get(String(uid)) || { owner: toPublicUser(byId.get(String(uid))), items: [] },
    items,
  };
};

const reserveUpload = async (uid, kind) => {
  await expire(uid);
  if ((await Status.countDocuments({ owner: uid, ...active() })) >= 3) throw full();
  const signed = media.signUpload(uid, kind);
  const publicId = `${signed.folder}/${crypto.randomUUID()}`;
  // Upload signatures last an hour. Pending receipts outlive them so late uploads cannot orphan files.
  const s = await Status.create({
    owner: uid,
    publicId,
    resourceType: signed.resourceType,
    expiresAt: new Date(Date.now() + 70 * 60000),
    uploadExpiresAt: new Date(Date.now() + 70 * 60000),
  });
  const params = {
    folder: signed.folder,
    timestamp: signed.timestamp,
    public_id: publicId.split('/').at(-1),
    overwrite: 'false',
  };
  return { ...signed, signature: media.sign(params), params, statusId: String(s._id) };
};

const publish = async (uid, { statusId, caption = '' }) => {
  const pending = await Status.findOne({ _id: statusId, owner: uid });
  if (!pending || pending.expiresAt <= new Date() || pending.state === 'deleting') throw missing();
  if (pending.state === 'active') return serialize(pending, uid); // retry after lost response
  const asset = await media.inspectResource(pending.publicId, pending.resourceType);
  const maxBytes = media.KINDS[`status_${pending.resourceType}`].maxBytes;
  const valid =
    asset.public_id === pending.publicId &&
    asset.resource_type === pending.resourceType &&
    Number.isFinite(asset.bytes) &&
    asset.bytes > 0 &&
    asset.bytes <= maxBytes &&
    (pending.resourceType === 'image'
      ? ['jpg', 'jpeg', 'png', 'webp', 'heic', 'avif'].includes(asset.format) && !asset.is_animated
      : ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(asset.format) &&
        asset.width > 0 &&
        asset.height > 0 &&
        asset.duration > 0 &&
        asset.duration <= 30);
  if (!valid)
    throw ApiError.badRequest(
      'Choose a photo up to 10 MB or a video up to 30 seconds / 30 MB',
      'INVALID_STATUS_MEDIA',
    );
  media.verifyUpload(uid, `status_${pending.resourceType}`, {
    publicId: asset.public_id,
    url: asset.secure_url,
  });
  await expire(uid);
  for (let slot = 0; slot < 3; slot += 1) {
    try {
      const publishedAt = new Date();
      const s = await Status.findOneAndUpdate(
        { _id: statusId, owner: uid, state: 'pending', expiresAt: { $gt: new Date() } },
        {
          $set: {
            state: 'active',
            slot,
            url: asset.secure_url,
            durationSec: pending.resourceType === 'video' ? asset.duration : 30,
            caption,
            publishedAt,
            expiresAt: new Date(publishedAt.getTime() + DAY_MS),
          },
        },
        { returnDocument: 'after' },
      );
      if (s) return serialize(s, uid);
      const already = await Status.findOne({ _id: statusId, owner: uid, ...active() });
      if (already) return serialize(already, uid);
      throw missing();
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw full();
};

const getVisible = async (uid, id) => {
  if (!mongoose.isValidObjectId(id)) throw missing();
  const s = await Status.findOne({ _id: id, ...active() }).lean();
  if (
    !s ||
    !(await contacts(uid)).includes(String(s.owner)) ||
    !(await User.exists({ _id: s.owner, status: 'active' }))
  )
    throw missing();
  return s;
};
const get = async (uid, id) => serialize(await getVisible(uid, id), uid);
const seen = async (uid, id) => {
  const s = await getVisible(uid, id);
  if (String(s.owner) !== String(uid))
    await Status.updateOne(
      { _id: id, ...active(), 'viewers.user': { $ne: uid } },
      { $push: { viewers: { user: uid, at: new Date() } } },
    );
  return { seen: true };
};
const viewers = async (uid, id) => {
  const s = await getVisible(uid, id);
  if (String(s.owner) !== String(uid)) throw missing();
  const blocked = await blockedIdsOf(uid);
  const users = await User.find({
    _id: { $in: s.viewers.map((v) => v.user) },
    status: 'active',
  }).lean();
  return {
    items: users
      .filter((u) => !blocked.has(String(u._id)))
      .map((u) => ({
        user: toPublicUser(u),
        seenAt: s.viewers.find((v) => String(v.user) === String(u._id)).at,
      })),
  };
};
const remove = async (uid, id) => {
  const s = await Status.findOneAndUpdate(
    { _id: id, owner: uid, state: 'active' },
    {
      $set: { state: 'deleting', viewers: [], caption: '' },
      $unset: { url: 1, durationSec: 1, publishedAt: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!s) throw missing();
  if ((await media.destroy(s.publicId, s.resourceType)) && s.uploadExpiresAt <= new Date())
    await Status.deleteOne({ _id: s._id, state: 'deleting' });
  return { deleted: true };
};
const purge = async () => {
  await expire();
  const rows = await Status.find({ state: 'deleting' }).sort({ expiresAt: 1 }).limit(100).lean();
  let deleted = 0;
  for (const s of rows) {
    // Early deletion cannot discard the receipt while its upload signature is still usable.
    if ((await media.destroy(s.publicId, s.resourceType)) && s.uploadExpiresAt <= new Date()) {
      await Status.deleteOne({ _id: s._id, state: 'deleting' });
      deleted += 1;
    }
  }
  return { deleted };
};
module.exports = { list, reserveUpload, publish, get, seen, viewers, remove, purge, contacts };
