// Admin API guard: header X-Admin-Key must equal ADMIN_API_KEY (constant-time compare).
// With no ADMIN_API_KEY configured the admin API answers 404 (as if it did not exist).
const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');

const requireAdmin = (req, res, next) => {
  if (!config.adminApiKey) return next(ApiError.notFound('Not found', 'ROUTE_NOT_FOUND'));
  const given = Buffer.from(String(req.get('x-admin-key') || ''));
  const expected = Buffer.from(config.adminApiKey);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return next(ApiError.unauthorized('Admin key required', 'ADMIN_UNAUTHORIZED'));
  return next();
};

module.exports = requireAdmin;
