const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const userRateLimit = require('../middlewares/userRateLimit');
const media = require('../services/media.service');

const router = Router();
router.use(authenticate);

// 36.1 / 37.2 a signed, user-scoped Cloudinary upload (the secret stays on the server)
router.post(
  '/sign',
  userRateLimit({ name: 'media-sign', limit: 60, windowSec: 3600 }),
  validate({
    body: Joi.object({
      kind: Joi.string()
        .valid(...Object.keys(media.KINDS))
        .required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { kind } = req.valid.body;
    const data = kind.startsWith('status_')
      ? await require('../services/status.service').reserveUpload(req.user._id, kind)
      : media.signUpload(req.user._id, kind);
    res.json({ success: true, data });
  }),
);

module.exports = router;
