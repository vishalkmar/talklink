// 1-to-1 text chat (Phase 23): conversations, messages, delivered / seen ticks, unread counts.
// Socket events: sockets/chat.socket.js; REST: routes/chat.routes.js. Docs: docs/SOCKET_EVENTS.md
// "Chat", docs/API.md "Chats".
//
// Ticks: sent (saved) -> delivered (receiver's app got chat:new) -> seen (receiver opened the chat).
// Unread counts live on the Conversation (unreadCount.<userId>), reset by markSeen.
// A conversation deleted "for me" hides everything older than clearedAt.<me>; a new message
// brings it back for both.
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const Block = require('../models/Block');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { toPublicUser } = require('../utils/serializers');
const { MAX_LENGTH, sanitizeText, hasLink, maskProfanity } = require('../utils/textFilter');
const { isBlockedEitherWay, hasBlocked } = require('./block.service');
const presence = require('./presence.service');
const push = require('./push.service');
const emitter = require('../sockets/emitter');
const registry = require('../sockets/registry');
const EVENTS = require('../constants/socketEvents.json');
const media = require('./media.service');

const { ObjectId } = mongoose.Types;
const PAGE_SIZE = 30;
const LIST_PAGE_SIZE = 30;
const EPHEMERAL_MS = 24 * 60 * 60 * 1000; // 23.16
const MAX_AUDIO_SEC = 120; // 36.3
const OPENED_MEDIA_TTL_MS = 10 * 60 * 1000; // 36.7 time to finish playing an opened voice note

// 36.9 what lists / pushes show instead of the content
const PREVIEW = { audio: '🎤 Voice message', viewOnce: '🔒 View once message' };
const previewOf = ({ type, viewOnce, text }) => {
  if (viewOnce) return PREVIEW.viewOnce;
  if (type === 'audio') return PREVIEW.audio;
  return text;
};

const settings = { ephemeralMs: EPHEMERAL_MS };

const notFound = () => ApiError.notFound('Chat not found', 'CHAT_NOT_FOUND');
const oid = (id) => new ObjectId(String(id));

// viewerId: who gets this copy. A view-once message shows no content to the receiver until they
// open it (chat:open-once), and to nobody after that.
const toMessage = (m, viewerId) => {
  const mine = viewerId && m.senderId && String(m.senderId) === String(viewerId);
  const hidden = Boolean(m.viewOnce) && (Boolean(m.openedAt) || (viewerId && !mine));
  const hasAudio = m.type === 'audio' && m.audio;
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: m.senderId ? String(m.senderId) : null,
    text: hidden ? '' : m.text || '',
    type: m.type,
    audio: hasAudio
      ? {
          url: hidden ? null : m.audio.url || null,
          durationSec: m.audio.durationSec || 0,
        }
      : null,
    viewOnce: Boolean(m.viewOnce),
    openedAt: m.openedAt || null,
    status: m.status,
    clientMsgId: m.clientMsgId || null,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt || null,
    seenAt: m.seenAt || null,
  };
};

const senderInfo = (u) => {
  const p = toPublicUser(u);
  return {
    id: p.id,
    name: p.name,
    gender: p.gender,
    avatar: p.avatar,
    privateNumber: p.privateNumber,
  };
};

const otherOf = (conv, uid) => conv.participants.find((p) => String(p) !== String(uid));

// --- conversations -------------------------------------------------------------------------

// 23.3 one permanent conversation per pair; race-safe through the unique participantsKey index.
const getOrCreateConversation = async (a, b) => {
  const participantsKey = Conversation.keyFor(a, b);
  const filter = { participantsKey, isRandomSession: false };
  try {
    return await Conversation.findOneAndUpdate(
      filter,
      { $setOnInsert: { participants: [oid(a), oid(b)], participantsKey, isRandomSession: false } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (err) {
    if (err.code === 11000) return Conversation.findOne(filter); // lost the race - it exists now
    throw err;
  }
};

const loadConversation = async (conversationId, uid) => {
  if (!mongoose.isValidObjectId(conversationId)) throw notFound();
  const conv = await Conversation.findById(conversationId);
  if (!conv || !conv.participants.some((p) => String(p) === String(uid))) throw notFound();
  return conv;
};

// participants cache for typing events (frequent, no DB write)
const participantCache = new Map(); // conversationId -> { ids, at }
const PARTICIPANT_TTL_MS = 10 * 60 * 1000;
const participantsOf = async (conversationId) => {
  const hit = participantCache.get(conversationId);
  if (hit && Date.now() - hit.at < PARTICIPANT_TTL_MS) return hit.ids;
  if (!mongoose.isValidObjectId(conversationId)) return null;
  const conv = await Conversation.findById(conversationId).select('participants').lean();
  if (!conv) return null;
  const ids = conv.participants.map(String);
  participantCache.set(conversationId, { ids, at: Date.now() });
  return ids;
};

// --- sending ---------------------------------------------------------------------------------

const cleanText = (text, { isRandomSession }) => {
  const clean = sanitizeText(text);
  if (!clean) throw ApiError.badRequest('Message is empty', 'EMPTY_MESSAGE');
  if (clean.length > MAX_LENGTH) {
    throw ApiError.badRequest(`Messages can be up to ${MAX_LENGTH} characters`, 'MESSAGE_TOO_LONG');
  }
  // 23.17 strangers can't send links (spam / phishing); friends you chose can
  if (isRandomSession && hasLink(clean)) {
    throw ApiError.badRequest('Links are not allowed in random chats', 'LINK_NOT_ALLOWED');
  }
  return maskProfanity(clean);
};

// 23.2 - 23.6, 23.10, 23.14, 23.15
const sendMessage = async (
  senderId,
  { conversationId, toUserId, text, clientMsgId, audio, viewOnce = false },
) => {
  const uid = String(senderId);

  // 23.15 a resend after reconnect returns the stored message instead of a copy
  if (clientMsgId) {
    const existing = await Message.findOne({ senderId: uid, clientMsgId }).lean();
    if (existing) return { message: toMessage(existing, uid), duplicate: true };
  }

  let conv;
  if (conversationId) {
    conv = await loadConversation(conversationId, uid);
  } else {
    if (!toUserId || !mongoose.isValidObjectId(toUserId)) throw notFound();
    if (String(toUserId) === uid)
      throw ApiError.badRequest("You can't message yourself", 'CANNOT_MESSAGE_SELF');
    const target = await User.findOne({ _id: toUserId, status: 'active' })
      .select('name gender settings')
      .lean();
    if (!target || !target.name || !target.gender) {
      throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
    }
    if (await isBlockedEitherWay(uid, toUserId))
      throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
    // 26.17 they only take messages from people they already talked to
    if (!(await require('./user.service').canStartChat(uid, target))) {
      throw ApiError.forbidden(
        `${target.name} only gets messages from people they have talked to`,
        'MESSAGES_NOT_ALLOWED',
      );
    }
    conv = await getOrCreateConversation(uid, toUserId);
  }
  const receiverId = String(otherOf(conv, uid));

  // 23.4 every message: a block either way stops the chat
  if (await isBlockedEitherWay(uid, receiverId)) {
    throw ApiError.forbidden("You can't message this user", 'CHAT_NOT_ALLOWED');
  }
  if (conv.isRandomSession && conv.endedAt) {
    throw ApiError.forbidden('This chat has ended', 'CHAT_ENDED');
  }
  // 36.2 a voice message (file already on Cloudinary, in this user's folder) or text
  let voice = null;
  if (audio) {
    const durationSec = Math.round(Number(audio.durationSec));
    if (!(durationSec >= 1 && durationSec <= MAX_AUDIO_SEC)) {
      throw ApiError.badRequest(
        `Voice messages can be up to ${MAX_AUDIO_SEC} seconds`,
        'AUDIO_TOO_LONG',
      );
    }
    const ok = media.verifyUpload(uid, 'chat_audio', audio);
    voice = { url: ok.url, publicId: ok.publicId, durationSec };
  }
  const body = voice ? '' : cleanText(text, conv);
  // random sessions (Phase 25): safety filter; required lazily (session.service uses this module)
  const sessions = conv.isRandomSession ? require('./session.service') : null;
  if (sessions && body) sessions.checkSafety(conv, body);
  const kind = { type: voice ? 'audio' : 'text', viewOnce: Boolean(viewOnce), text: body };

  let msg;
  try {
    msg = await Message.create({
      conversationId: conv._id,
      senderId: uid,
      text: body,
      type: kind.type,
      audio: voice || undefined,
      viewOnce: kind.viewOnce,
      status: 'sent',
      clientMsgId: clientMsgId || undefined,
    });
  } catch (err) {
    if (err.code === 11000 && clientMsgId) {
      // same clientMsgId sent twice at the same moment - the first one won
      const existing = await Message.findOne({ senderId: uid, clientMsgId }).lean();
      return { message: toMessage(existing, uid), duplicate: true };
    }
    throw err;
  }

  // 23.10 last message + receiver's unread count; a chat deleted "for me" comes back
  await Conversation.updateOne(
    { _id: conv._id },
    {
      $set: {
        lastMessage: { text: previewOf(kind), senderId: oid(uid), createdAt: msg.createdAt },
      },
      $inc: { [`unreadCount.${receiverId}`]: 1 },
      $pull: { deletedFor: { $in: [oid(uid), oid(receiverId)] } },
    },
  );

  if (sessions) sessions.touch(String(conv._id)); // 25.13 idle timer starts again
  require('./gamification.service')
    .bump(uid, 'messages', 1) // 32.8 goal progress
    .catch(() => {});
  const message = toMessage(msg, uid);
  const sender = await User.findById(uid).lean();
  const base = {
    conversation: { id: String(conv._id), isRandomSession: Boolean(conv.isRandomSession) },
    sender: sender ? senderInfo(sender) : { id: uid },
  };
  // the receiver's copy never carries view-once content (36.7)
  emitter.emitToUser(receiverId, EVENTS.CHAT_NEW, { ...base, message: toMessage(msg, receiverId) });
  emitter.emitToUser(uid, EVENTS.CHAT_NEW, { ...base, message }); // my other devices (deduped by id)

  // 23.14 offline receiver: push with name + preview
  if ((await registry.socketCount(receiverId)) === 0) {
    push
      .sendToUser(
        receiverId,
        push.PUSH.NEW_MESSAGE,
        {
          conversationId: String(conv._id),
          messageId: message.id,
          senderId: uid,
          senderName: (sender && sender.name) || 'Someone',
          preview:
            kind.type === 'text' && !kind.viewOnce && body.length > 80
              ? `${body.slice(0, 79)}…`
              : previewOf(kind),
        },
        { ttlSec: 24 * 3600 },
      )
      .catch((err) => logger.warn({ err: err.message }, 'message push failed'));
  }
  return { message, conversationId: String(conv._id) };
};

// --- ticks -----------------------------------------------------------------------------------

// 23.7 the receiver's app got these messages
const markDelivered = async (uid, { conversationId, messageIds }) => {
  const conv = await loadConversation(conversationId, uid);
  const ids = (messageIds || []).filter((id) => mongoose.isValidObjectId(id)).map(oid);
  if (!ids.length) return { count: 0 };
  const filter = {
    _id: { $in: ids },
    conversationId: conv._id,
    senderId: { $ne: oid(uid) },
    status: 'sent',
  };
  const updated = await Message.find(filter).select('_id senderId').lean();
  if (!updated.length) return { count: 0 };
  const now = new Date();
  await Message.updateMany(
    { _id: { $in: updated.map((m) => m._id) } },
    { $set: { status: 'delivered', deliveredAt: now } },
  );
  const senderId = String(otherOf(conv, uid));
  emitter.emitToUser(senderId, EVENTS.CHAT_DELIVERED, {
    conversationId: String(conv._id),
    messageIds: updated.map((m) => String(m._id)),
    deliveredAt: now,
  });
  return { count: updated.length };
};

// 23.8 the receiver opened the chat: everything unseen becomes seen (blue ticks)
const markSeen = async (uid, { conversationId }) => {
  const conv = await loadConversation(conversationId, uid);
  const filter = { conversationId: conv._id, senderId: { $ne: oid(uid) }, status: { $ne: 'seen' } };
  const unseen = await Message.find(filter).select('_id').lean();
  const now = new Date();
  if (unseen.length) {
    const ids = unseen.map((m) => m._id);
    await Message.updateMany({ _id: { $in: ids } }, { $set: { status: 'seen', seenAt: now } });
    // seen without a delivered report first (the app opened straight into the chat)
    await Message.updateMany(
      { _id: { $in: ids }, deliveredAt: { $exists: false } },
      { $set: { deliveredAt: now } },
    );
  }
  await Conversation.updateOne({ _id: conv._id }, { $set: { [`unreadCount.${uid}`]: 0 } });
  if (unseen.length) {
    emitter.emitToUser(String(otherOf(conv, uid)), EVENTS.CHAT_SEEN, {
      conversationId: String(conv._id),
      messageIds: unseen.map((m) => String(m._id)),
      seenAt: now,
    });
  }
  emitter.emitToUser(uid, EVENTS.CHAT_SEEN, {
    conversationId: String(conv._id),
    byMe: true,
    seenAt: now,
  });
  return { count: unseen.length };
};

// 23.9 not stored; only to the other participant
const relayTyping = async (uid, conversationId, event) => {
  const ids = await participantsOf(String(conversationId));
  if (!ids || !ids.includes(String(uid))) throw notFound();
  const other = ids.find((id) => id !== String(uid));
  emitter.emitToUser(other, event, { conversationId: String(conversationId), from: String(uid) });
};

// --- REST ------------------------------------------------------------------------------------

const encodeCursor = (c) =>
  Buffer.from(JSON.stringify({ t: c.updatedAt.toISOString(), id: String(c._id) })).toString(
    'base64url',
  );
const decodeCursor = (cursor) => {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const date = new Date(t);
    if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) throw new Error('bad');
    return { date, id: oid(id) };
  } catch {
    throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
  }
};

// 23.11 my conversations, newest activity first
const listChats = async (userId, { cursor, limit = LIST_PAGE_SIZE } = {}) => {
  const uid = oid(userId);
  const and = [
    { participants: uid },
    { deletedFor: { $ne: uid } },
    { isRandomSession: false },
    { 'lastMessage.createdAt': { $exists: true } },
  ];
  if (cursor) {
    const c = decodeCursor(cursor);
    and.push({ $or: [{ updatedAt: { $lt: c.date } }, { updatedAt: c.date, _id: { $lt: c.id } }] });
  }
  const convs = await Conversation.find({ $and: and })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = convs.length > limit;
  const page = hasMore ? convs.slice(0, limit) : convs;

  const otherIds = page.map((c) => String(otherOf(c, userId)));
  const [users, myBlocks] = await Promise.all([
    User.find({ _id: { $in: otherIds } }).lean(),
    Block.find({ blockerId: uid, blockedId: { $in: otherIds } })
      .select('blockedId')
      .lean(),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const blocked = new Set(myBlocks.map((b) => String(b.blockedId)));

  const items = page.map((c) => {
    const otherId = String(otherOf(c, userId));
    const other = byId.get(otherId);
    const cleared = c.clearedAt && c.clearedAt[String(userId)];
    const lastVisible = !cleared || new Date(c.lastMessage.createdAt) > new Date(cleared);
    return {
      id: String(c._id),
      peer:
        other && other.status === 'active'
          ? toPublicUser(other)
          : { id: otherId, name: null, deleted: true },
      lastMessage: lastVisible
        ? {
            text: c.lastMessage.text,
            mine: String(c.lastMessage.senderId) === String(userId),
            createdAt: c.lastMessage.createdAt,
          }
        : null,
      unreadCount: (c.unreadCount && c.unreadCount[String(userId)]) || 0,
      isBlocked: blocked.has(otherId),
      updatedAt: c.updatedAt,
    };
  });
  const totalUnread = await unreadTotal(userId);
  return { items, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null, totalUnread };
};

const unreadTotal = async (userId) => {
  const key = `unreadCount.${String(userId)}`;
  const [row] = await Conversation.aggregate([
    {
      $match: {
        participants: oid(userId),
        deletedFor: { $ne: oid(userId) },
        isRandomSession: false,
      },
    },
    { $group: { _id: null, total: { $sum: { $ifNull: [`$${key}`, 0] } } } },
  ]);
  return row ? row.total : 0;
};

// 23.12 newest first, 30 per page; `before` = id of the oldest message the app already has
const listMessages = async (userId, conversationId, { before, limit = PAGE_SIZE } = {}) => {
  const conv = await loadConversation(conversationId, userId);
  const uid = String(userId);
  const and = [{ conversationId: conv._id }, { deletedFor: { $ne: oid(uid) } }];
  const cleared = conv.clearedAt && conv.clearedAt.get(uid);
  if (cleared) and.push({ createdAt: { $gt: cleared } });
  if (before) {
    if (!mongoose.isValidObjectId(before))
      throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
    const pivot = await Message.findOne({ _id: before, conversationId: conv._id })
      .select('createdAt')
      .lean();
    if (!pivot) throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
    and.push({
      $or: [
        { createdAt: { $lt: pivot.createdAt } },
        { createdAt: pivot.createdAt, _id: { $lt: oid(before) } },
      ],
    });
  }
  const rows = await Message.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const otherId = String(otherOf(conv, uid));
  const [other, blockedByMe, blockedMe, otherPresence] = await Promise.all([
    User.findById(otherId).lean(),
    hasBlocked(uid, otherId),
    hasBlocked(otherId, uid),
    presence.getPresence(otherId),
  ]);
  const active = Boolean(other && other.status === 'active');
  return {
    conversation: {
      id: String(conv._id),
      isRandomSession: Boolean(conv.isRandomSession),
      endedAt: conv.endedAt || null,
      peer: active ? toPublicUser(other) : { id: otherId, name: null, deleted: true },
      unreadCount: (conv.unreadCount && conv.unreadCount.get(uid)) || 0,
      // 24.4 / 24.16 header status and input bar; a block by them only shows as "can't reply"
      online: active && !blockedMe && otherPresence.state !== presence.STATE.OFFLINE,
      blockedByMe: Boolean(blockedByMe),
      canReply: active && !blockedByMe && !blockedMe && !conv.endedAt,
    },
    items: page.map((m) => toMessage(m, uid)),
    nextBefore: hasMore ? String(page[page.length - 1]._id) : null,
  };
};

// 23.13 delete for me only: hidden until a new message arrives; old messages stay hidden
const deleteChatForMe = async (userId, conversationId) => {
  const conv = await loadConversation(conversationId, userId);
  const uid = String(userId);
  await Conversation.updateOne(
    { _id: conv._id },
    {
      $addToSet: { deletedFor: oid(uid) },
      $set: { [`clearedAt.${uid}`]: new Date(), [`unreadCount.${uid}`]: 0 },
    },
  );
  return { deleted: true };
};

// 24.15 "Clear chat": empty my history but keep the chat in my list
const clearChatForMe = async (userId, conversationId) => {
  const conv = await loadConversation(conversationId, userId);
  const uid = String(userId);
  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { [`clearedAt.${uid}`]: new Date(), [`unreadCount.${uid}`]: 0 } },
  );
  return { cleared: true };
};

// 24.19 "Delete for me" on one message
const deleteMessageForMe = async (userId, conversationId, messageId) => {
  const conv = await loadConversation(conversationId, userId);
  if (!mongoose.isValidObjectId(messageId)) {
    throw ApiError.notFound('Message not found', 'MESSAGE_NOT_FOUND');
  }
  const res = await Message.updateOne(
    { _id: messageId, conversationId: conv._id },
    { $addToSet: { deletedFor: oid(userId) } },
  );
  if (!res.matchedCount) throw ApiError.notFound('Message not found', 'MESSAGE_NOT_FOUND');
  return { deleted: true };
};

// 23.16 random-session chats vanish 24 h after the session ends (Phase 25 calls this)
const scheduleEphemeralDelete = async (conversationId, endedAt = new Date()) => {
  const expiresAt = new Date(endedAt.getTime() + settings.ephemeralMs);
  await Promise.all([
    Conversation.updateOne(
      { _id: conversationId, isRandomSession: true },
      { $set: { expiresAt, endedAt } },
    ),
    Message.updateMany({ conversationId }, { $set: { expiresAt } }),
  ]);
  return expiresAt;
};

// 36.7 the receiver opens a view-once message: they get the content once, then it is wiped.
// Atomic - two devices opening at the same moment can't both get it.
const openViewOnce = async (userId, { conversationId, messageId }) => {
  const uid = String(userId);
  const conv = await loadConversation(conversationId, uid);
  if (!mongoose.isValidObjectId(messageId)) {
    throw ApiError.notFound('Message not found', 'MESSAGE_NOT_FOUND');
  }
  const now = new Date();
  const before = await Message.findOneAndUpdate(
    {
      _id: messageId,
      conversationId: conv._id,
      viewOnce: true,
      senderId: { $ne: oid(uid) },
      openedAt: { $exists: false },
      deletedFor: { $ne: oid(uid) },
    },
    {
      $set: {
        openedAt: now,
        text: '',
        mediaPurgeAt: new Date(now.getTime() + OPENED_MEDIA_TTL_MS),
      },
    },
    { returnDocument: 'before' },
  ).lean();
  if (!before) {
    const exists = await Message.exists({
      _id: messageId,
      conversationId: conv._id,
      viewOnce: true,
    });
    if (exists) throw ApiError.conflict('This message was already opened', 'ALREADY_OPENED');
    throw ApiError.notFound('Message not found', 'MESSAGE_NOT_FOUND');
  }
  const opened = { conversationId: String(conv._id), messageId: String(before._id), openedAt: now };
  emitter.emitToUsers([uid, String(before.senderId)], EVENTS.CHAT_OPENED, opened);
  return {
    ...opened,
    text: before.text || '',
    audio:
      before.type === 'audio' && before.audio
        ? { url: before.audio.url, durationSec: before.audio.durationSec || 0 }
        : null,
  };
};

// 36.7 / 23.16 voice files of opened view-once messages and of random-chat messages about to
// expire are deleted from Cloudinary. Runs every few minutes (jobs/index.js).
const purgeMedia = async (now = new Date()) => {
  const soon = new Date(now.getTime() + OPENED_MEDIA_TTL_MS);
  const rows = await Message.find({
    'audio.publicId': { $exists: true, $ne: null },
    $or: [{ mediaPurgeAt: { $lte: now } }, { expiresAt: { $lte: soon } }],
  })
    .select('_id audio')
    .limit(200)
    .lean();
  let purged = 0;
  for (const m of rows) {
    if (await media.destroy(m.audio.publicId, 'video')) {
      await Message.updateOne(
        { _id: m._id },
        { $unset: { 'audio.url': 1, 'audio.publicId': 1, mediaPurgeAt: 1 } },
      );
      purged += 1;
    }
  }
  return purged ? { purged } : null;
};

const __clearCacheForTests = () => participantCache.clear();

module.exports = {
  settings,
  PAGE_SIZE,
  toMessage,
  getOrCreateConversation,
  sendMessage,
  markDelivered,
  markSeen,
  relayTyping,
  listChats,
  listMessages,
  deleteChatForMe,
  clearChatForMe,
  deleteMessageForMe,
  scheduleEphemeralDelete,
  unreadTotal,
  openViewOnce,
  purgeMedia,
  PREVIEW,
  __clearCacheForTests,
};
