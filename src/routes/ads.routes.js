// Rewarded ads (Phase 28). /ssv is called by Google (no login); the rest by the app.
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const ads = require('../services/ads.service');

const router = Router();

// 28.9 - 28.11 server-side verification callback (set this URL in the AdMob console)
router.get(
  '/ssv',
  asyncHandler(async (req, res) => {
    const raw = req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : '';
    const { status, body } = await ads.handleSsv(raw);
    res.status(status).json(body);
  }),
);

router.use(authenticate);

// 28.10 one nonce per ad, sent to Google as custom data
router.post(
  '/nonce',
  validate({
    body: Joi.object({
      purpose: Joi.string()
        .valid(...ads.PURPOSES)
        .default('credits'),
      device: Joi.object({ emulator: Joi.boolean() }).default({}), // 30.16
    }),
  }),
  asyncHandler(async (req, res) => {
    const { purpose, device } = req.valid.body;
    res.json({ success: true, data: await ads.createNonce(req.user._id, purpose, device) });
  }),
);

// dev only (ADMOB_SSV_ENABLED=false): the app reports the reward itself
router.post(
  '/claim',
  validate({ body: Joi.object({ nonce: Joi.string().hex().length(32).required() }) }),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ads.claim(req.user._id, req.valid.body) });
  }),
);

module.exports = router;
