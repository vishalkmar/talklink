const Joi = require('joi');
const callService = require('../services/call.service');
const ringing = require('../services/ringing.service');
const directCall = require('../services/directCall.service');
const { getIceServers } = require('../services/turn.service');

const schemas = {
  history: {
    query: Joi.object({
      cursor: Joi.string().max(300),
      limit: Joi.number().integer().min(1).max(50).default(callService.DEFAULT_LIMIT),
      filter: Joi.string().valid('all', 'audio', 'text', 'missed').default('all'),
      q: Joi.string().trim().max(30).allow(''),
    }),
  },
  callId: { params: Joi.object({ id: Joi.string().max(64).required() }) },
  direct: {
    body: Joi.object({
      calleeId: Joi.string().max(64).required(),
      mode: Joi.string().valid('audio').default('audio'), // direct text chats open the chat (Phase 24)
    }),
  },
  rate: {
    params: Joi.object({ id: Joi.string().max(64).required() }),
    body: Joi.object({ stars: Joi.number().integer().min(1).max(5).required() }),
  },
};

const history = async (req, res) => {
  const data = await callService.listHistory(req.user._id, req.valid.query);
  res.json({ success: true, data });
};

const hide = async (req, res) => {
  await callService.hideCall(req.user._id, req.valid.params.id);
  res.json({ success: true, data: { deleted: true } });
};

// 22.5 start a direct call: { roomId, callId, expiresAt, delivered, mode, peer }
const direct = async (req, res) => {
  const data = await directCall.startDirectCall(req.user, req.valid.body);
  res.status(201).json({ success: true, data });
};

// 21.10 "Decline" on the incoming-call notification, without opening the app
const decline = async (req, res) => {
  const data = await ringing.declineCall(req.valid.params.id, String(req.user._id));
  res.json({ success: true, data });
};

const rate = async (req, res) => {
  const data = await callService.rateCall(req.user._id, req.valid.params.id, req.valid.body.stars);
  res.json({ success: true, data });
};

// 17.12 / 17.13 fetched by the app right before each call (credentials expire after TURN_TTL).
const iceServers = (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: getIceServers(String(req.user._id)) });
};

module.exports = { schemas, history, hide, direct, rate, decline, iceServers };
