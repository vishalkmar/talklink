// IP-based limits. Per-email OTP limits live in the store (Phase 4).
// NOTE: in-memory store - switch to a Store store when running multiple instances (Phase 34).
const rateLimit = require('express-rate-limit');
const ApiError = require('../utils/ApiError');
const config = require('../config');

// IP limits are off in tests (many requests from one IP); per-email limits are tested instead.
const skip = () => config.isTest;

const handler = (req, res, next, options) =>
  next(
    ApiError.tooMany('Too many requests, please slow down', 'RATE_LIMITED', {
      retryAfterSec: Math.ceil(options.windowMs / 1000),
    }),
  );

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip,
});

module.exports = { globalLimiter, authLimiter };
