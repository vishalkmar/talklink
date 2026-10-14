const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const calls = require('../controllers/call.controller');

const router = Router();

router.use(authenticate);

router.get('/history', validate(calls.schemas.history), asyncHandler(calls.history));
router.get('/ice-servers', calls.iceServers);
router.post('/direct', validate(calls.schemas.direct), asyncHandler(calls.direct));
router.post('/:id/decline', validate(calls.schemas.callId), asyncHandler(calls.decline));
router.post('/:id/rating', validate(calls.schemas.rate), asyncHandler(calls.rate));
router.delete('/:id', validate(calls.schemas.callId), asyncHandler(calls.hide));

module.exports = router;
