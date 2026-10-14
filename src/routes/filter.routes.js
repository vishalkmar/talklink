// Gender filter unlock (Phase 30).
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const filters = require('../services/filter.service');

const router = Router();
router.use(authenticate);

// { cost, passMinutes, premium, active: { gender, until } | null }
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await filters.getStatus(req.user) });
  }),
);

// 30.7 spend credits -> { gender, until, balance } (402 INSUFFICIENT_CREDITS)
router.post(
  '/unlock',
  validate({
    body: Joi.object({
      gender: Joi.string()
        .valid(...filters.GENDERS)
        .required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await filters.unlock(req.user, req.valid.body.gender) });
  }),
);

module.exports = router;
