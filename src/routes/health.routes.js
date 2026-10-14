const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { health } = require('../controllers/health.controller');

const router = Router();

router.get('/', asyncHandler(health));

// keep-alive target: instant answer, no database work (jobs/index.js pings it every few minutes)
router.get('/ping', (req, res) => res.type('text/plain').send('pong'));

module.exports = router;
