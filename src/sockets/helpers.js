// Small helpers shared by every socket module.
const { store } = require('../config/store');
const logger = require('../utils/logger');

// Per-user event limits (13.13): [max events, window seconds]. Anything not listed uses DEFAULT.
const RATE_LIMITS = {
  'match:request': [10, 60],
  'match:accept': [30, 60],
  'call:incoming': [20, 3600],
  'chat:send': [30, 60],
  'chat:typing': [120, 60],
  'session:next': [20, 60], // 25.18 rapid Next presses
  'call:ice': [600, 60], // trickle ICE sends many small messages
  DEFAULT: [120, 60],
};

const limitFor = (event) => RATE_LIMITS[event] || RATE_LIMITS.DEFAULT;

// socket.use() middleware: counts events per user + event name in the store (works across devices
// and instances). Over the limit the event is dropped and its ack (if any) gets RATE_LIMITED.
const rateLimitMiddleware = (socket) => async (packet, next) => {
  const [event, ...args] = packet;
  const [max, windowSec] = limitFor(event);
  try {
    const k = `rl:sock:${socket.data.userId}:${event}`;
    const count = await store.incr(k);
    if (count === 1) await store.expire(k, windowSec);
    if (count > max) {
      const ack = args[args.length - 1];
      if (typeof ack === 'function') {
        ack({ ok: false, code: 'RATE_LIMITED', message: 'Too many requests, slow down' });
      }
      logger.warn({ userId: socket.data.userId, event }, 'Socket event rate-limited');
      return undefined; // swallow the event
    }
  } catch (err) {
    logger.error({ err }, 'Socket rate limiter failed - allowing event');
  }
  return next();
};

// Wraps a handler so every acknowledged event answers { ok: true, ...result } or
// { ok: false, code, message, details? } - errors never leave an ack hanging (13.12).
const withAck = (handler) => async (payload, ack) => {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    const result = await handler(payload || {});
    reply({ ok: true, ...(result || {}) });
  } catch (err) {
    const code = err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    if (!err.isOperational) logger.error({ err }, 'Socket handler error');
    const body = {
      ok: false,
      code,
      message: err.isOperational ? err.message : 'Something went wrong',
    };
    if (err.isOperational && err.details) body.details = err.details;
    reply(body);
  }
};

module.exports = { RATE_LIMITS, rateLimitMiddleware, withAck };
