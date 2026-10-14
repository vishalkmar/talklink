// Verifies "Authorization: Bearer <accessToken>" and loads req.user.
// Expired tokens return 401 TOKEN_EXPIRED so the app refreshes silently and retries.
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../services/token.service');

const authenticate = async (req, res, next) => {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing access token', 'UNAUTHORIZED');
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);
    if (!user || user.status === 'deleted') {
      throw ApiError.unauthorized('Account not found', 'INVALID_TOKEN');
    }
    if (user.status !== 'active') {
      throw ApiError.forbidden('This account is not active', 'ACCOUNT_SUSPENDED');
    }

    req.user = user;
    if (req.log) req.log = req.log.child({ userId: String(user._id) });
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = authenticate;
