// Fixed-window rate limit per signed-in user, stored in the store (works across instances).
const { store } = require('../config/store');
const ApiError = require('../utils/ApiError');

const userRateLimit =
  ({ name, limit, windowSec }) =>
  async (req, res, next) => {
    try {
      const key = `rl:${name}:${req.user._id}`;
      const count = await store.incr(key);
      if (count === 1) await store.expire(key, windowSec);
      if (count > limit) {
        const ttl = await store.ttl(key);
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
