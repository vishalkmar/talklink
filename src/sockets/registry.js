// Which sockets (devices) each user has open, across all server instances (13.5).
// Redis set user:<id>:sockets. The TTL is a safety net: if a server instance crashes, its socket
// ids disappear on their own instead of making the user look connected forever.
const { redis } = require('../config/redis');

const TTL_SEC = 6 * 3600;
const key = (userId) => `user:${userId}:sockets`;

const addSocket = async (userId, socketId) => {
  await redis.multi().sadd(key(userId), socketId).expire(key(userId), TTL_SEC).exec();
};

// Returns how many sockets the user still has.
const removeSocket = async (userId, socketId) => {
  const [, [, count]] = await redis.multi().srem(key(userId), socketId).scard(key(userId)).exec();
  return count;
};

const socketCount = (userId) => redis.scard(key(userId));

module.exports = { addSocket, removeSocket, socketCount, key };
