const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const referrals = require('../services/referral.service');

const router = Router();
router.use(authenticate);

// 33.8 my code, link and how many friends joined
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await referrals.getMine(req.user._id) });
  }),
);

// 33.8 a new user enters a friend's code (once)
router.post(
  '/apply',
  validate({ body: Joi.object({ code: Joi.string().trim().max(20).required() }) }),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await referrals.applyCode(req.user._id, req.valid.body.code) });
  }),
);

module.exports = router;
