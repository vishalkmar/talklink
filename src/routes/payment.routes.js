// Payments (Phase 31): plans, Cashfree orders, verification, webhook, history.
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { PLANS, PREMIUM_BENEFITS } = require('../constants/plans');
const payments = require('../services/payment.service');
const cashfree = require('../services/cashfree.service');

const router = Router();

// 31.11 Cashfree -> us (no login; signed). Body is raw here (app.js).
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const data = await payments.handleWebhook(raw, req.headers);
    res.json({ success: true, data });
  }),
);

router.use(authenticate);

// 31.3 what can be bought (prices from .env)
router.get('/plans', (req, res) => {
  res.json({
    success: true,
    data: { plans: PLANS, benefits: PREMIUM_BENEFITS, available: cashfree.isConfigured() },
  });
});

// 31.5 / 31.6
router.post(
  '/create-order',
  validate({
    body: Joi.object({
      planId: Joi.string().max(40).required(),
      phone: Joi.string()
        .pattern(/^[6-9]\d{9}$/)
        .messages({ 'string.pattern.base': 'Enter a valid 10-digit mobile number' }),
    }),
  }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json({ success: true, data: await payments.createOrder(req.user, req.valid.body) });
  }),
);

// 31.9 the app calls this after the SDK says done - the server asks Cashfree itself
router.get(
  '/verify/:orderId',
  validate({ params: Joi.object({ orderId: Joi.string().max(60).required() }) }),
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await payments.verifyOrder(req.valid.params.orderId, req.user._id),
    });
  }),
);

// 31.17
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await payments.listPayments(req.user._id) });
  }),
);

module.exports = router;
