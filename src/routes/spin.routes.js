// Spin wheel (Phase 29).
const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const spin = require('../services/spin.service');

const router = Router();
router.use(authenticate);

// segments, today's spins (free / video), reset time, last 10 results
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await spin.status(req.user._id) });
  }),
);

// spin now -> { segmentIndex, credits, free, balance, left, freeLeft, adSpins, resetsAt }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await spin.spin(req.user._id) });
  }),
);

module.exports = router;
