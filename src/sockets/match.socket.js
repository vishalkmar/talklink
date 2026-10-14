// Matchmaking socket events (Phase 15). Logic lives in services/match.service.js.
const Joi = require('joi');
const EVENTS = require('../constants/socketEvents.json');
const match = require('../services/match.service');
const ApiError = require('../utils/ApiError');
const { withAck } = require('./helpers');

const validate = (schema, payload) => {
  const { value, error } = schema.validate(payload, { stripUnknown: true });
  if (error) throw ApiError.badRequest(error.details[0].message, 'VALIDATION_ERROR');
  return value;
};

const requestSchema = Joi.object({
  mode: Joi.string().valid('audio', 'text').required(),
  connectWith: Joi.string().valid('anyone', 'male', 'female').default('anyone'),
});
const idSchema = Joi.object({ requestId: Joi.string().guid({ version: 'uuidv4' }).required() });

module.exports = (io, socket) => {
  const uid = socket.data.userId;

  socket.on(
    EVENTS.MATCH_REQUEST,
    withAck(async (payload) => match.requestMatch(uid, validate(requestSchema, payload))),
  );
  socket.on(
    EVENTS.MATCH_ACCEPT,
    withAck(async (payload) => match.acceptMatch(uid, validate(idSchema, payload).requestId)),
  );
  socket.on(
    EVENTS.MATCH_DECLINE,
    withAck(async (payload) => match.declineMatch(uid, validate(idSchema, payload).requestId)),
  );
  socket.on(
    EVENTS.MATCH_CANCEL,
    withAck(async (payload) => match.cancelMatch(uid, validate(idSchema, payload).requestId)),
  );
};
