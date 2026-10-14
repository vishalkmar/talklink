// Gives every request an id (reuses a sane incoming X-Request-Id) and echoes it back.
const { randomUUID } = require('crypto');

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestId = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestId;
