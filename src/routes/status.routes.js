const { Router } = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const userRateLimit = require('../middlewares/userRateLimit');
const asyncHandler = require('../utils/asyncHandler');
const status = require('../services/status.service');
const router = Router();
router.use(authenticate);
const id = Joi.string().hex().length(24).required();
const respond = (fn) =>
  asyncHandler(async (req, res) => res.json({ success: true, data: await fn(req) }));
router.get(
  '/',
  respond((req) => status.list(req.user._id)),
);
router.post(
  '/',
  userRateLimit({ name: 'status-publish', limit: 60, windowSec: 3600 }),
  validate({
    body: Joi.object({ statusId: id, caption: Joi.string().trim().max(300).allow('').default('') }),
  }),
  respond((req) => status.publish(req.user._id, req.valid.body)),
);
router.use('/:id', validate({ params: Joi.object({ id }) }));
router.get(
  '/:id',
  respond((req) => status.get(req.user._id, req.params.id)),
);
router.post(
  '/:id/seen',
  respond((req) => status.seen(req.user._id, req.params.id)),
);
router.get(
  '/:id/viewers',
  respond((req) => status.viewers(req.user._id, req.params.id)),
);
router.delete(
  '/:id',
  respond((req) => status.remove(req.user._id, req.params.id)),
);
module.exports = router;
