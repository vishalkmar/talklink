// Wallet (Phase 27). Earning endpoints for ads / spin come in Phases 28 / 29.
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const wallet = require('../services/wallet.service');

const router = Router();
router.use(authenticate);

// 27.6
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await wallet.getWallet(req.user._id) });
  }),
);

// 27.7
router.get(
  '/transactions',
  validate({
    query: Joi.object({
      cursor: Joi.string().max(64),
      limit: Joi.number().integer().min(1).max(50).default(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await wallet.listTransactions(req.user._id, req.valid.query) });
  }),
);

// 27.14 once per IST day; the app calls it when the main app opens
router.post(
  '/daily-bonus',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await wallet.claimDailyBonus(req.user._id) });
  }),
);

module.exports = router;
