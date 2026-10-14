const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { createUniqueUser, isDuplicateKey } = require('../utils/privateNumber');
const otpService = require('./otp.service');
const tokenService = require('./token.service');
const walletService = require('./wallet.service');
const config = require('../config');
const logger = require('../utils/logger');

const assertActive = (user) => {
  if (user.status !== 'active') {
    throw ApiError.forbidden('This account is not active', 'ACCOUNT_SUSPENDED');
  }
};

// 11.11 Starting credits for every new account (idempotent: refId signup_bonus:<userId>).
// A failure here must not block login - it is logged and can be granted again safely.
const grantSignupBonus = async (user) => {
  const amount = config.economy.signupBonusCredits;
  if (!amount) return;
  try {
    const { balance } = await walletService.credit({
      userId: user._id,
      amount,
      type: 'signup_bonus',
      refId: walletService.signupBonusRef(user._id),
    });
    user.credits = balance;
  } catch (err) {
    logger.error({ err, userId: String(user._id) }, 'Signup bonus failed');
  }
};

// Find the user for this email, or create one (with a fresh private number).
const findOrCreateUser = async (email) => {
  const existing = await User.findOne({ email });
  if (existing) return { user: existing, created: false };
  try {
    const user = await createUniqueUser({ email });
    await grantSignupBonus(user);
    return { user, created: true };
  } catch (err) {
    // Two verify requests raced to create the same email - use the winner.
    if (isDuplicateKey(err, 'email')) {
      return { user: await User.findOne({ email }), created: false };
    }
    throw err;
  }
};

const loginWithOtp = async ({ email, otp, device, ip }) => {
  await otpService.verifyOtp(email, otp);
  const { user, created } = await findOrCreateUser(email);
  assertActive(user);
  const tokens = await tokenService.issueTokens({ userId: user._id, device, ip });
  return { user, isNewUser: created, tokens };
};

const refresh = async ({ refreshToken, device, ip }) => {
  const { userId, tokens } = await tokenService.rotateRefreshToken({ refreshToken, device, ip });
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('Account not found', 'INVALID_REFRESH_TOKEN');
  assertActive(user);
  return { user, tokens };
};

const logout = (refreshToken) => tokenService.revokeRefreshToken(refreshToken);

module.exports = { loginWithOtp, refresh, logout, findOrCreateUser };
