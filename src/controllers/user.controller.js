const Joi = require('joi');
const userService = require('../services/user.service');
const otpService = require('../services/otp.service');

// r***@gmail.com
const maskEmail = (email) => email.replace(/^(.)[^@]*(@.*)$/, '$1***$2');
const { toPrivateUser, toPublicUser } = require('../utils/serializers');
const { PROFILE_RULES, DIRECT_CALL_PRIVACY } = require('../constants/appConfig');
const { AVATAR_IDS } = require('../constants/avatars');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const schemas = {
  updateMe: {
    // privateNumber, credits, email, isPremium... are not in the schema, so they are stripped.
    body: Joi.object({
      name: Joi.string()
        .trim()
        .min(PROFILE_RULES.nameMinLength)
        .max(PROFILE_RULES.nameMaxLength)
        // \p{M} = combining marks, e.g. Hindi matras in "राहुल"
        .pattern(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]*$/u)
        .messages({
          'string.pattern.base': 'name can only contain letters, numbers, spaces, . _ -',
        }),
      gender: Joi.string().valid(...PROFILE_RULES.genders),
      avatar: Joi.string()
        .valid(...AVATAR_IDS)
        .allow(null),
      ageConfirmed: Joi.boolean().valid(true), // 34.17 can only be confirmed, never undone
    })
      .min(1)
      .messages({ 'object.min': 'Nothing to update' }),
  },
  byNumber: {
    params: Joi.object({
      privateNumber: Joi.string()
        .pattern(/^\d{5,6}$/)
        .required()
        .messages({ 'string.pattern.base': 'privateNumber must be 5-6 digits' }),
    }),
  },
  publicById: { params: Joi.object({ id: Joi.string().max(64).required() }) },
  settings: {
    body: Joi.object({
      directCalls: Joi.string().valid(...DIRECT_CALL_PRIVACY),
      strangerMessages: Joi.boolean(),
      showLastSeen: Joi.boolean(),
      // 33.7
      notifications: Joi.object({
        calls: Joi.boolean(),
        messages: Joi.boolean(),
        streakReminders: Joi.boolean(),
        promotions: Joi.boolean(),
      }).min(1),
      dnd: Joi.object({
        enabled: Joi.boolean(),
        start: Joi.string().pattern(HHMM),
        end: Joi.string().pattern(HHMM),
      }).min(1),
    }).min(1),
  },
  // 33.17
  deleteMe: {
    body: Joi.object({
      otp: Joi.string()
        .pattern(/^\d{6}$/)
        .required(),
    }),
  },
  fcmToken: { body: Joi.object({ token: Joi.string().trim().min(20).max(4096).required() }) },
};

const getMe = (req, res) => {
  res.json({ success: true, data: { user: toPrivateUser(req.user) } });
};

const updateMe = async (req, res) => {
  const user = await userService.updateProfile(req.user, req.body);
  res.json({ success: true, data: { user: toPrivateUser(user) } });
};

const getByNumber = async (req, res) => {
  const user = await userService.findByPrivateNumber(req.user._id, req.valid.params.privateNumber);
  res.json({ success: true, data: { user: toPublicUser(user) } });
};

// 26.1 - 26.18: the public profile + what I may do with this person
const getPublic = async (req, res) => {
  const user = await userService.findPublicById(req.user._id, req.valid.params.id);
  const extra = await userService.profileExtrasFor(req.user._id, user);
  res.json({ success: true, data: { user: { ...toPublicUser(user), ...extra } } });
};

// 22.11 / 26.17 / 26.18 / 33.7
const updateSettings = async (req, res) => {
  const user = await userService.updateSettings(req.user, req.valid.body);
  res.json({ success: true, data: { user: toPrivateUser(user) } });
};

const setFcmToken = async (req, res) => {
  await userService.setFcmToken(req.user, req.body.token);
  res.json({ success: true, data: { saved: true } });
};

// 21.2 logout: this device must stop receiving calls / messages
const clearFcmToken = async (req, res) => {
  await userService.clearFcmToken(req.user);
  res.json({ success: true, data: { cleared: true } });
};

// 33.17 step 1: a code to the account email
const requestDeleteOtp = async (req, res) => {
  const data = await otpService.sendOtp(req.user.email, { purpose: 'delete' });
  res.json({ success: true, data: { ...data, email: maskEmail(req.user.email) } });
};

// 33.17 step 2: the code confirms the deletion
const deleteMe = async (req, res) => {
  await otpService.verifyOtp(req.user.email, req.valid.body.otp, { purpose: 'delete' });
  await userService.deleteAccount(req.user);
  res.json({ success: true, data: { deleted: true } });
};

module.exports = {
  schemas,
  getMe,
  updateMe,
  getByNumber,
  getPublic,
  updateSettings,
  setFcmToken,
  clearFcmToken,
  requestDeleteOtp,
  deleteMe,
};
