// Text chat socket events (Phase 23). Logic lives in services/chat.service.js.
// Rate limits (helpers.RATE_LIMITS): chat:send 30/min, chat:typing 120/min.
const Joi = require('joi');
const EVENTS = require('../constants/socketEvents.json');
const chat = require('../services/chat.service');
const ApiError = require('../utils/ApiError');
const { withAck } = require('./helpers');

const objectId = Joi.string().hex().length(24);

const schemas = {
  send: Joi.object({
    conversationId: objectId,
    toUserId: objectId,
    text: Joi.string().max(4000).required(), // trimmed + limited to 1000 by the service
    clientMsgId: Joi.string()
      .max(64)
      .pattern(/^[A-Za-z0-9_-]+$/),
  }).xor('conversationId', 'toUserId'),
  delivered: Joi.object({
    conversationId: objectId.required(),
    messageIds: Joi.array().items(objectId).min(1).max(200).required(),
  }),
  conversation: Joi.object({ conversationId: objectId.required() }),
};

const validate = (schema, payload) => {
  const { value, error } = schema.validate(payload, { stripUnknown: true });
  if (error) throw ApiError.badRequest(error.details[0].message, 'VALIDATION_ERROR');
  return value;
};

module.exports = (io, socket) => {
  const uid = socket.data.userId;

  // 23.2 send (ack -> { message, conversationId } or { message, duplicate: true })
  socket.on(
    EVENTS.CHAT_SEND,
    withAck(async (payload) => chat.sendMessage(uid, validate(schemas.send, payload))),
  );

  // 23.7 my app received these messages
  socket.on(
    EVENTS.CHAT_DELIVERED,
    withAck(async (payload) => chat.markDelivered(uid, validate(schemas.delivered, payload))),
  );

  // 23.8 I opened the chat
  socket.on(
    EVENTS.CHAT_SEEN,
    withAck(async (payload) => chat.markSeen(uid, validate(schemas.conversation, payload))),
  );

  // 23.9 typing indicator, not stored
  [EVENTS.CHAT_TYPING, EVENTS.CHAT_STOP_TYPING].forEach((event) => {
    socket.on(
      event,
      withAck(async (payload) => {
        const { conversationId } = validate(schemas.conversation, payload);
        await chat.relayTyping(uid, conversationId, event);
        return {};
      }),
    );
  });
};
