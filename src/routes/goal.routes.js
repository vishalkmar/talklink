// Goals, streak and leaderboard (Phase 32).
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const gamification = require('../services/gamification.service');

const router = Router();
router.use(authenticate);

// streak, aura, badges, today's + this week's goals
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await gamification.getGoals(req.user._id) });
  }),
);

// 32.12 top aura this week
router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await gamification.leaderboard(req.user._id) });
  }),
);

// 32.13 after a streak-saver video (ads purpose 'streak')
router.post(
  '/streak-saver',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await gamification.useStreakSaver(String(req.user._id)) });
  }),
);

// 32.10
router.post(
  '/:id/claim',
  validate({ params: Joi.object({ id: Joi.string().max(40).required() }) }),
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await gamification.claimGoal(req.user._id, req.valid.params.id),
    });
  }),
);

module.exports = router;
