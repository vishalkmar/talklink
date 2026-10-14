const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { REPORT_REASONS } = require('../constants/appConfig');
const reportService = require('../services/report.service');

const router = Router();
router.use(authenticate);

// 26.13
router.post(
  '/',
  validate({
    body: Joi.object({
      userId: Joi.string().max(64).required(),
      reason: Joi.string()
        .valid(...REPORT_REASONS)
        .required(),
      note: Joi.string().trim().max(500).allow(''),
      callId: Joi.string().max(64),
      conversationId: Joi.string().max(64),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await reportService.createReport(req.user._id, req.valid.body);
    res.status(201).json({ success: true, data });
  }),
);

module.exports = router;
