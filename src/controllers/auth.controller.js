const Joi = require('joi');
const authService = require('../services/auth.service');
const otpService = require('../services/otp.service');
const { toPrivateUser } = require('../utils/serializers');

const email = Joi.string().trim().lowercase().email().max(254).required();
const device = Joi.object({
  platform: Joi.string().valid('android', 'ios').default('android'),
  model: Joi.string().max(60).allow(''),
  appVersion: Joi.string().max(20).allow(''),
});
const refreshToken = Joi.string().min(20).max(200).required();

const schemas = {
  sendOtp: { body: Joi.object({ email }) },
  verifyOtp: {
    body: Joi.object({
      email,
      otp: Joi.string()
        .pattern(/^\d{6}$/)
        .required()
        .messages({ 'string.pattern.base': 'otp must be 6 digits' }),
      device,
    }),
  },
  refresh: { body: Joi.object({ refreshToken, device }) },
  logout: { body: Joi.object({ refreshToken }) },
};

const sendOtp = async (req, res) => {
  const result = await otpService.sendOtp(req.body.email);
  res.json({ success: true, data: { email: req.body.email, ...result } });
};

const verifyOtp = async (req, res) => {
  const { user, isNewUser, tokens } = await authService.loginWithOtp({
    email: req.body.email,
    otp: req.body.otp,
    device: req.body.device,
    ip: req.ip,
  });
  res.json({ success: true, data: { user: toPrivateUser(user), isNewUser, tokens } });
};

const refresh = async (req, res) => {
  const { user, tokens } = await authService.refresh({
    refreshToken: req.body.refreshToken,
    device: req.body.device,
    ip: req.ip,
  });
  res.json({ success: true, data: { user: toPrivateUser(user), tokens } });
};

const logout = async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.json({ success: true, data: { loggedOut: true } });
};

module.exports = { schemas, sendOtp, verifyOtp, refresh, logout };
