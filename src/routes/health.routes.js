const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { health } = require('../controllers/health.controller');

const router = Router();

router.get('/', asyncHandler(health));

module.exports = router;
