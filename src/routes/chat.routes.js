const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const chats = require('../controllers/chat.controller');

const router = Router();

router.use(authenticate);

router.get('/', validate(chats.schemas.list), asyncHandler(chats.list));
router.get('/:id/messages', validate(chats.schemas.messages), asyncHandler(chats.messages));
router.delete('/:id', validate(chats.schemas.chatId), asyncHandler(chats.remove));
router.post('/:id/clear', validate(chats.schemas.chatId), asyncHandler(chats.clear));
router.delete(
  '/:id/messages/:messageId',
  validate(chats.schemas.message),
  asyncHandler(chats.removeMessage),
);

module.exports = router;
