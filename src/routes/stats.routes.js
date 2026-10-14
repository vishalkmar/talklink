// GET /stats/online (14.10) - "X people online" on the Call tab.
const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const presence = require('../services/presence.service');

const router = Router();

router.get(
  '/online',
  authenticate,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, max-age=15');
    res.json({ success: true, data: { online: await presence.onlineCount() } });
  }),
);

module.exports = router;
