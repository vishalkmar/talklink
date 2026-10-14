// io.use() middleware (13.3): the app connects with { auth: { token: <accessToken> } }.
// On failure the client receives connect_error with err.data.code:
//   UNAUTHORIZED (no token) | TOKEN_EXPIRED (refresh and reconnect) | INVALID_TOKEN | ACCOUNT_SUSPENDED
const User = require('../models/User');
const { verifyAccessToken } = require('../services/token.service');

const fail = (code, message) => {
  const err = new Error(message);
  err.data = { code };
  return err;
};

const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token || typeof token !== 'string') return next(fail('UNAUTHORIZED', 'Missing token'));

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      return next(fail(err.code || 'INVALID_TOKEN', err.message));
    }

    const user = await User.findById(payload.sub)
      .select('name gender avatar privateNumber status')
      .lean();
    if (!user || user.status === 'deleted') return next(fail('INVALID_TOKEN', 'Account not found'));
    if (user.status !== 'active') return next(fail('ACCOUNT_SUSPENDED', 'Account not active'));

    socket.data.userId = String(user._id);
    socket.data.user = {
      id: String(user._id),
      name: user.name || null,
      gender: user.gender || null,
      avatar: user.avatar || null,
      privateNumber: user.privateNumber,
    };
    return next();
  } catch (err) {
    return next(fail('INTERNAL_ERROR', 'Authentication failed'));
  }
};

module.exports = socketAuth;
