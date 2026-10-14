// Fixed-window rate limit per signed-in user, stored in Redis (works across instances).
const { redis } = require('../config/redis');
const ApiError = require('../utils/ApiError');

const userRateLimit =
  ({ name, limit, windowSec }) =>
  async (req, res, next) => {
    try {
      const key = `rl:${name}:${req.user._id}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      if (count > limit) {
        const ttl = await redis.ttl(key);
        throw ApiError.tooMany('Too many requests, please slow down', 'RATE_LIMITED', {
          retryAfterSec: Math.max(ttl, 1),
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };

module.exports = userRateLimit;
