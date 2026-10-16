const mongoose = require('mongoose');
const User = require('../models/User');
const Otp = require('../models/Otp');
const ApiError = require('../utils/ApiError');
const { PROFILE_RULES } = require('../constants/appConfig');
const { isBlockedEitherWay } = require('./block.service');
const tokenService = require('./token.service');
const { checkName } = require('../utils/nameFilter');
const sockets = require('../sockets/emitter');

const DAY_MS = 24 * 60 * 60 * 1000;

const notFound = () => ApiError.notFound('User not found', 'USER_NOT_FOUND');

// Name / avatar change any time. Gender: free the first time, then at most once per
// genderChangeCooldownDays (stops people flipping gender to game the gender filter).
const NAME_ERRORS = {
  PROFANITY: 'Please choose a different name',
  RESERVED: 'This name is reserved. Please choose a different one',
};

const updateProfile = async (user, { name, gender, avatar, ageConfirmed }) => {
  if (ageConfirmed && !user.ageConfirmedAt) user.ageConfirmedAt = new Date(); // 34.17
  if (name !== undefined) {
    const problem = checkName(name);
    if (problem) throw ApiError.badRequest(NAME_ERRORS[problem], 'NAME_NOT_ALLOWED');
    user.name = name;
  }
  if (avatar !== undefined) user.avatar = avatar;

  if (gender !== undefined && gender !== user.gender) {
    if (user.gender && user.genderChangedAt) {
      const nextChangeAt = new Date(
        user.genderChangedAt.getTime() + PROFILE_RULES.genderChangeCooldownDays * DAY_MS,
      );
      if (nextChangeAt > new Date()) {
        throw new ApiError(
          403,
          'GENDER_CHANGE_LOCKED',
          `Gender can be changed once every ${PROFILE_RULES.genderChangeCooldownDays} days`,
          { nextChangeAt },
        );
      }
    }
    user.gender = gender;
    user.genderChangedAt = new Date();
  }

  await user.save();
  return user;
};

// Another user, as the viewer may see them: 404 if missing, inactive, not set up yet,
// or if either side blocked the other (never reveal a block).
const findVisibleUser = async (viewerId, filter) => {
  const user = await User.findOne({ ...filter, status: 'active' });
  if (!user || !user.name || !user.gender) throw notFound();
  if (!user._id.equals(viewerId) && (await isBlockedEitherWay(viewerId, user._id))) {
    throw notFound();
  }
  return user;
};

const findByPrivateNumber = (viewerId, privateNumber) =>
  findVisibleUser(viewerId, { privateNumber });

const findPublicById = (viewerId, id) => {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return findVisibleUser(viewerId, { _id: id });
};

// One FCM token belongs to one device; if another account used this device, detach it there.
const setFcmToken = async (user, token) => {
  await User.updateMany({ fcmToken: token, _id: { $ne: user._id } }, { $unset: { fcmToken: 1 } });
  user.fcmToken = token;
  await user.save();
};

const updateSettings = async (
  user,
  { directCalls, strangerMessages, showLastSeen, notifications, dnd },
) => {
  if (directCalls !== undefined) user.set('settings.directCalls', directCalls);
  if (strangerMessages !== undefined) user.set('settings.strangerMessages', strangerMessages);
  if (showLastSeen !== undefined) user.set('settings.showLastSeen', showLastSeen);
  // 33.7 partial objects: only the given switches change
  Object.entries(notifications || {}).forEach(([k, v]) =>
    user.set(`settings.notifications.${k}`, v),
  );
  Object.entries(dnd || {}).forEach(([k, v]) => user.set(`settings.dnd.${k}`, v));
  if (dnd && dnd.start !== undefined && dnd.start === (dnd.end ?? user.settings.dnd.end)) {
    throw ApiError.badRequest('Start and end time must be different', 'DND_INVALID');
  }
  await user.save();
  return user;
};

// Have these two talked before (a chat or a call that connected)?
const havePastContact = async (a, b) => {
  const Conversation = require('../models/Conversation');
  const Call = require('../models/Call');
  const pair = [
    { callerId: a, calleeId: b },
    { callerId: b, calleeId: a },
  ];
  const [conv, call] = await Promise.all([
    Conversation.exists({
      participantsKey: Conversation.keyFor(a, b),
      isRandomSession: false,
      'lastMessage.createdAt': { $exists: true },
    }),
    Call.exists({ $or: pair, startedAt: { $exists: true } }),
  ]);
  return Boolean(conv || call);
};

// 26.17: may `viewerId` start a chat with `target`?
const canStartChat = async (viewerId, target) =>
  !(target.settings && target.settings.strangerMessages === false) ||
  havePastContact(String(viewerId), String(target._id));

// 26.17 / 26.18 viewer-specific bits of a public profile
const profileExtrasFor = async (viewerId, target) => {
  const presence = require('./presence.service');
  const showLastSeen = !(target.settings && target.settings.showLastSeen === false);
  const p = showLastSeen ? await presence.getPresence(String(target._id)) : null;
  const online = Boolean(p && p.state !== presence.STATE.OFFLINE);
  const lastSeenAt = p && !online ? p.lastSeen || target.lastSeenAt || null : null;
  return {
    canMessage: await canStartChat(viewerId, target),
    online: showLastSeen ? online : null,
    lastSeenAt: showLastSeen && lastSeenAt ? new Date(lastSeenAt) : null,
  };
};

const clearFcmToken = async (user) => {
  await User.updateOne({ _id: user._id }, { $unset: { fcmToken: 1 } });
};

// Account deletion (Play Store requirement). Personal data is wiped and every session revoked.
// The private number stays reserved so it is never reassigned to someone else.
const deleteAccount = async (user) => {
  const email = user.email;
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        status: 'deleted',
        email: `deleted+${user._id}@deleted.invalid`,
        isPremium: false,
      },
      $unset: {
        name: 1,
        avatar: 1,
        fcmToken: 1,
        gender: 1,
        genderChangedAt: 1,
        lastSeenAt: 1,
        billingPhone: 1,
      },
    },
  );
  await Promise.all([
    tokenService.revokeAllForUser(user._id),
    Otp.deleteOne({ email }),
    require('../models/Status').updateMany(
      { owner: user._id, state: 'active' },
      {
        $set: { state: 'deleting', viewers: [], caption: '' },
        $unset: { url: 1, durationSec: 1, publishedAt: 1 },
      },
    ),
  ]);
  sockets.disconnectUser(String(user._id)); // close every open connection of this account
};

module.exports = {
  updateSettings,
  canStartChat,
  profileExtrasFor,
  havePastContact,
  clearFcmToken,
  updateProfile,
  findByPrivateNumber,
  findPublicById,
  setFcmToken,
  deleteAccount,
};
