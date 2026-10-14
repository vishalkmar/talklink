const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const { authLimiter } = require('../middlewares/rateLimiters');
const auth = require('../controllers/auth.controller');

const router = Router();

router.use(authLimiter);

router.post('/send-otp', validate(auth.schemas.sendOtp), asyncHandler(auth.sendOtp));
router.post('/verify-otp', validate(auth.schemas.verifyOtp), asyncHandler(auth.verifyOtp));
router.post('/refresh', validate(auth.schemas.refresh), asyncHandler(auth.refresh));
router.post('/logout', validate(auth.schemas.logout), asyncHandler(auth.logout));

module.exports = router;
