// WebRTC signaling over Socket.IO (Phase 17). The server never touches media - it only relays
// SDP offers/answers and ICE candidates between the two participants of a live call.
// Sequence diagram: docs/SOCKET_EVENTS.md "Call signaling".
const Joi = require('joi');
const EVENTS = require('../constants/socketEvents.json');
const callSession = require('../services/callSession.service');
const ringing = require('../services/ringing.service');
const { isBlockedEitherWay } = require('../services/block.service');
const { redis } = require('../config/redis');
const ApiError = require('../utils/ApiError');
const { withAck } = require('./helpers');

const roomId = Joi.string().hex().length(24).required();
const sdp = Joi.object({
  type: Joi.string().valid('offer', 'answer', 'pranswer', 'rollback').required(),
  sdp: Joi.string().max(20000).allow(''),
}).required();
const candidate = Joi.object({
  candidate: Joi.string().max(1000).allow('').required(),
  sdpMid: Joi.string().max(64).allow(null),
  sdpMLineIndex: Joi.number().integer().min(0).max(64).allow(null),
  usernameFragment: Joi.string().max(256).allow(null),
}).required();

const schemas = {
  sdp: Joi.object({ roomId, sdp }),
  ice: Joi.object({ roomId, candidate }),
  mute: Joi.object({ roomId, muted: Joi.boolean().required() }),
  hold: Joi.object({ roomId, onHold: Joi.boolean().required() }),
  room: Joi.object({ roomId }),
  end: Joi.object({ roomId, reason: Joi.string().valid('hangup', 'declined').default('hangup') }),
};

const validate = (schema, payload) => {
  const { value, error } = schema.validate(payload, { stripUnknown: true });
  if (error) throw ApiError.badRequest(error.details[0].message, 'VALIDATION_ERROR');
  return value;
};

module.exports = (io, socket) => {
  const uid = socket.data.userId;

  // participant + this device bound to the call
  const enter = async (id) => {
    const call = await callSession.assertParticipant(id, uid);
    await callSession.bindSocket(call, uid, socket.id);
    return call;
  };

  // 17.11 a block between the two ends the call (checked once per call, on the first offer/answer)
  const ensureNotBlocked = async (call) => {
    if (call.blockChecked) return;
    if (await isBlockedEitherWay(call.callerId, call.calleeId)) {
      await callSession.endCall(call.roomId, { reason: 'blocked', endedBy: uid });
      throw ApiError.forbidden('This call is not allowed', 'CALL_NOT_ALLOWED');
    }
    await redis.hset(callSession.keys.call(call.roomId), 'blockChecked', '1');
  };

  const relaySdp = (event) =>
    withAck(async (payload) => {
      const { roomId: id, sdp: desc } = validate(schemas.sdp, payload);
      const call = await enter(id);
      await ensureNotBlocked(call);
      callSession.relay(call, uid, event, { sdp: desc });
      return {};
    });

  socket.on(EVENTS.CALL_OFFER, relaySdp(EVENTS.CALL_OFFER)); // 17.4
  socket.on(EVENTS.CALL_ANSWER, relaySdp(EVENTS.CALL_ANSWER)); // 17.5
  socket.on(EVENTS.CALL_ICE_RESTART, relaySdp(EVENTS.CALL_ICE_RESTART)); // 17.10 (new offer, iceRestart)

  // 17.6 trickle ICE, both directions
  socket.on(
    EVENTS.CALL_ICE,
    withAck(async (payload) => {
      const { roomId: id, candidate: cand } = validate(schemas.ice, payload);
      const call = await enter(id);
      callSession.relay(call, uid, EVENTS.CALL_ICE, { candidate: cand });
      return {};
    }),
  );

  socket.on(
    EVENTS.CALL_MUTE_STATE,
    withAck(async (payload) => {
      const { roomId: id, muted } = validate(schemas.mute, payload);
      const call = await enter(id);
      callSession.relay(call, uid, EVENTS.CALL_MUTE_STATE, { muted });
      return {};
    }),
  );

  // 20.16 a regular phone (GSM) call took the audio: the other side shows "On hold"
  socket.on(
    EVENTS.CALL_HOLD,
    withAck(async (payload) => {
      const { roomId: id, onHold } = validate(schemas.hold, payload);
      const call = await enter(id);
      callSession.relay(call, uid, EVENTS.CALL_HOLD, { onHold });
      return {};
    }),
  );

  // WebRTC connected on this side -> the call becomes active (first report wins)
  socket.on(
    EVENTS.CALL_CONNECTED,
    withAck(async (payload) => {
      const { roomId: id } = validate(schemas.room, payload);
      await enter(id);
      return { startedAt: await callSession.markConnected(id) };
    }),
  );

  // 21.9 answer a ringing direct call from this device
  socket.on(
    EVENTS.CALL_ACCEPT,
    withAck(async (payload) => {
      const { roomId: id } = validate(schemas.room, payload);
      return ringing.acceptCall(id, uid, socket.id);
    }),
  );

  // 21.10 decline a ringing direct call
  socket.on(
    EVENTS.CALL_DECLINE,
    withAck(async (payload) => {
      const { roomId: id } = validate(schemas.room, payload);
      return ringing.declineCall(id, uid);
    }),
  );

  // 17.8 hang up
  socket.on(
    EVENTS.CALL_END,
    withAck(async (payload) => {
      const { roomId: id, reason } = validate(schemas.end, payload);
      await callSession.assertParticipant(id, uid);
      const summary = await callSession.endCall(id, { reason, endedBy: uid });
      return summary || { alreadyEnded: true };
    }),
  );
};
