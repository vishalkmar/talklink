// NoSQL-injection + HTTP parameter pollution guard (replaces express-mongo-sanitize and hpp,
// which both reassign req.query - a read-only getter in Express 5).
//  - Drops keys that start with "$" or contain "." from body, params and query.
//  - Query params repeated in the URL (?a=1&a=2) keep only the last value.

const isUnsafeKey = (key) => key.startsWith('$') || key.includes('.');

const clean = (value, depth = 0) => {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!isUnsafeKey(k)) out[k] = clean(v, depth + 1);
  }
  return out;
};

const sanitize = (req, res, next) => {
  // raw bodies (Buffer, e.g. the signed payment webhook) must stay untouched
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req.body = clean(req.body);
  }
  if (req.params) req.params = clean(req.params);

  const query = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    if (isUnsafeKey(k)) continue;
    query[k] = Array.isArray(v) ? v[v.length - 1] : clean(v);
  }
  // An own property shadows Express 5's req.query getter for the rest of the request.
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });

  next();
};

module.exports = sanitize;
