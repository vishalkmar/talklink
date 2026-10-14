// Random text session events (Phase 25). Logic: services/session.service.js.
const Joi = require('joi');
const EVENTS = require('../constants/socketEvents.json');
const sessions = require('../services/session.service');
const ApiError = require('../utils/ApiError');
const { withAck } = require('./helpers');

const schema = Joi.object({ conversationId: Joi.string().hex().length(24).required() });

const validate = (payload) => {
  const { value, error } = schema.validate(payload, { stripUnknown: true });
  if (error) throw ApiError.badRequest(error.details[0].message, 'VALIDATION_ERROR');
  return value.conversationId;
};

module.exports = (io, socket) => {
  const uid = socket.data.userId;

  // 25.5 End (the app asks for confirmation first)
  socket.on(
    EVENTS.SESSION_END,
    withAck(async (payload) => {
      const id = validate(payload);
      await sessions.assertMember(id, uid);
      const summary = await sessions.endSession(id, { reason: 'ended', endedBy: uid });
      return summary || { alreadyEnded: true };
    }),
  );

  // 25.4 Next: end + search again -> { requestId, expiresAt } like match:request
  socket.on(
    EVENTS.SESSION_NEXT,
    withAck(async (payload) => sessions.nextSession(uid, validate(payload))),
  );

  // 25.7 Add to chats
  socket.on(
    EVENTS.SESSION_ADD,
    withAck(async (payload) => sessions.requestAdd(uid, validate(payload))),
  );
};
