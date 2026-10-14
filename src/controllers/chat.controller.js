const Joi = require('joi');
const chat = require('../services/chat.service');

const id = Joi.string().max(64).required();

const schemas = {
  list: {
    query: Joi.object({
      cursor: Joi.string().max(300),
      limit: Joi.number().integer().min(1).max(50).default(30),
    }),
  },
  messages: {
    params: Joi.object({ id }),
    query: Joi.object({
      before: Joi.string().max(64),
      limit: Joi.number().integer().min(1).max(50).default(chat.PAGE_SIZE),
    }),
  },
  chatId: { params: Joi.object({ id }) },
  message: { params: Joi.object({ id, messageId: id }) },
};

// 23.11
const list = async (req, res) => {
  res.json({ success: true, data: await chat.listChats(req.user._id, req.valid.query) });
};

// 23.12
const messages = async (req, res) => {
  const data = await chat.listMessages(req.user._id, req.valid.params.id, req.valid.query);
  res.json({ success: true, data });
};

// 23.13
const remove = async (req, res) => {
  res.json({ success: true, data: await chat.deleteChatForMe(req.user._id, req.valid.params.id) });
};

// 24.15
const clear = async (req, res) => {
  res.json({ success: true, data: await chat.clearChatForMe(req.user._id, req.valid.params.id) });
};

// 24.19
const removeMessage = async (req, res) => {
  const { id: chatId, messageId } = req.valid.params;
  res.json({ success: true, data: await chat.deleteMessageForMe(req.user._id, chatId, messageId) });
};

module.exports = { schemas, list, messages, remove, clear, removeMessage };
