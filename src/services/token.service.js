// Access tokens: short-lived JWTs. Refresh tokens: opaque random strings, stored only as a
// SHA-256 hash in the Session collection and rotated on every use.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { toSeconds } = require('../utils/duration');
const Session = require('../models/Session');

const ACCESS_TTL_SEC = toSeconds(config.jwt.accessTtl);
const REFRESH_TTL_SEC = toSeconds(config.jwt.refreshTtl);

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const signAccessToken = (userId) =>
  jwt.sign({ typ: 'access' }, config.jwt.accessSecret, {
    subject: String(userId),
    expiresIn: ACCESS_TTL_SEC,
    algorithm: 'HS256',
  });

// Throws ApiError TOKEN_EXPIRED / INVALID_TOKEN. Returns the decoded payload.
const verifyAccessToken = (token) => {
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret, { algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
};

const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');

const createSession = async ({ userId, device, ip, familyId = crypto.randomUUID() }) => {
  const refreshToken = newRefreshToken();
  await Session.create({
    userId,
    tokenHash: hashToken(refreshToken),
    familyId,
    device,
    ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
  });
  return refreshToken;
};

const issueTokens = async ({ userId, device, ip, familyId }) => {
  const refreshToken = await createSession({ userId, device, ip, familyId });
  return {
    accessToken: signAccessToken(userId),
    refreshToken,
    accessTokenExpiresIn: ACCESS_TTL_SEC,
    refreshTokenExpiresIn: REFRESH_TTL_SEC,
  };
};

const revokeFamily = (familyId) =>
  Session.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });

// Rotates a refresh token. Reusing an already-rotated token revokes the whole login (theft signal).
const rotateRefreshToken = async ({ refreshToken, device, ip }) => {
  const tokenHash = hashToken(refreshToken);
  const session = await Session.findOne({ tokenHash });

  if (!session) throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  if (session.revokedAt) {
    await revokeFamily(session.familyId);
    throw ApiError.unauthorized('Refresh token was already used', 'REFRESH_TOKEN_REUSED');
  }
  if (session.expiresAt <= new Date()) {
    throw ApiError.unauthorized('Refresh token expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const nextToken = newRefreshToken();
  const nextHash = hashToken(nextToken);
  // Atomic claim: only one concurrent refresh with the same token can win.
  const claimed = await Session.findOneAndUpdate(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedBy: nextHash } },
  );
  if (!claimed) {
    await revokeFamily(session.familyId);
    throw ApiError.unauthorized('Refresh token was already used', 'REFRESH_TOKEN_REUSED');
  }

  await Session.create({
    userId: session.userId,
    tokenHash: nextHash,
    familyId: session.familyId,
    device: device || session.device,
    ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
  });

  return {
    userId: session.userId,
    tokens: {
      accessToken: signAccessToken(session.userId),
      refreshToken: nextToken,
      accessTokenExpiresIn: ACCESS_TTL_SEC,
      refreshTokenExpiresIn: REFRESH_TTL_SEC,
    },
  };
};

// Logout: revokes every token of this login (other devices stay logged in).
const revokeRefreshToken = async (refreshToken) => {
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) });
  if (session) await revokeFamily(session.familyId);
};

const revokeAllForUser = (userId) =>
  Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueTokens,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  hashToken,
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
};
