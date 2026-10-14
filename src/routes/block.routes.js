// Blocks. Phase 12: POST (block). Phase 24: DELETE (unblock). Phase 26: GET (list).
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const blockService = require('../services/block.service');

const router = Router();

router.use(authenticate);

// 26.16 people I blocked (Blocked Users screen)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await blockService.listBlocked(req.user._id) });
  }),
);

router.post(
  '/',
  validate({ body: Joi.object({ userId: Joi.string().max(64).required() }) }),
  asyncHandler(async (req, res) => {
    const data = await blockService.blockUser(req.user._id, req.body.userId);
    res.json({ success: true, data });
  }),
);

router.delete(
  '/:userId',
  validate({ params: Joi.object({ userId: Joi.string().max(64).required() }) }),
  asyncHandler(async (req, res) => {
    const data = await blockService.unblockUser(req.user._id, req.valid.params.userId);
    res.json({ success: true, data });
  }),
);

module.exports = router;
