const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const feedback = require('../services/feedback.service');

const router = Router();
router.use(authenticate);

// 33.12 Contact Us
router.post(
  '/',
  validate({
    body: Joi.object({
      type: Joi.string().valid('feedback', 'problem', 'idea').required(),
      message: Joi.string().trim().min(5).max(2000).required(),
      contact: Joi.string().trim().max(120).allow(''),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await feedback.submit(req.user, req.valid.body, {
      appVersion: (req.get('x-app-version') || '').slice(0, 20) || undefined,
      platform: (req.get('x-platform') || '').slice(0, 20) || undefined,
    });
    res.status(201).json({ success: true, data });
  }),
);

module.exports = router;
