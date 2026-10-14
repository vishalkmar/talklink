// presence:set (14.6) + per-socket heartbeat. Offline handling lives in sockets/index.js
// (it knows how many sockets the user still has after a disconnect).
const Joi = require('joi');
const EVENTS = require('../constants/socketEvents.json');
const presence = require('../services/presence.service');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { withAck } = require('./helpers');

const schema = Joi.object({
  available: Joi.boolean().required(), // "Available for random calls" toggle
  foreground: Joi.boolean().default(true), // app state
  autoAccept: Joi.boolean().default(false), // 15.17 auto-accept random requests
});

module.exports = (io, socket) => {
  const uid = socket.data.userId;

  presence.onConnect(uid).catch((err) => logger.error({ err, uid }, 'presence.onConnect failed'));

  const heartbeat = setInterval(() => {
    presence.touch(uid).catch(() => {});
  }, presence.settings.heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();
  socket.on('disconnect', () => clearInterval(heartbeat));

  socket.on(
    EVENTS.PRESENCE_SET,
    withAck(async (payload) => {
      const { value, error } = schema.validate(payload);
      if (error) throw ApiError.badRequest(error.details[0].message, 'VALIDATION_ERROR');
      const state = await presence.setClientState(uid, value);
      return { state };
    }),
  );
};
