const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const userRateLimit = require('../middlewares/userRateLimit');
const { SEARCH_LIMIT_PER_MIN } = require('../constants/appConfig');
const users = require('../controllers/user.controller');

const router = Router();

const searchLimit = userRateLimit({
  name: 'user-search',
  limit: SEARCH_LIMIT_PER_MIN,
  windowSec: 60,
});

router.use(authenticate);

router.get('/me', users.getMe);
router.patch('/me', validate(users.schemas.updateMe), asyncHandler(users.updateMe));
router.post('/me/delete-otp', asyncHandler(users.requestDeleteOtp));
router.delete('/me', validate(users.schemas.deleteMe), asyncHandler(users.deleteMe));
router.patch('/me/settings', validate(users.schemas.settings), asyncHandler(users.updateSettings));
router.post('/me/fcm-token', validate(users.schemas.fcmToken), asyncHandler(users.setFcmToken));
router.delete('/me/fcm-token', asyncHandler(users.clearFcmToken));
router.get(
  '/by-number/:privateNumber',
  searchLimit,
  validate(users.schemas.byNumber),
  asyncHandler(users.getByNumber),
);
router.get(
  '/:id/public',
  searchLimit,
  validate(users.schemas.publicById),
  asyncHandler(users.getPublic),
);

module.exports = router;
