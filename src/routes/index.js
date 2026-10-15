// Mounted at /api/v1. Each feature adds its router here.
const { Router } = require('express');

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const callRoutes = require('./call.routes');
const chatRoutes = require('./chat.routes');
const reportRoutes = require('./report.routes');
const walletRoutes = require('./wallet.routes');
const adsRoutes = require('./ads.routes');
const spinRoutes = require('./spin.routes');
const filterRoutes = require('./filter.routes');
const paymentRoutes = require('./payment.routes');
const goalRoutes = require('./goal.routes');
const referralRoutes = require('./referral.routes');
const feedbackRoutes = require('./feedback.routes');
const contentRoutes = require('./content.routes');
const mediaRoutes = require('./media.routes');
const blockRoutes = require('./block.routes');
const statsRoutes = require('./stats.routes');
const adminRoutes = require('./admin.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/calls', callRoutes);
router.use('/chats', chatRoutes);
router.use('/blocks', blockRoutes);
router.use('/reports', reportRoutes);
router.use('/wallet', walletRoutes);
router.use('/ads', adsRoutes);
router.use('/spin', spinRoutes);
router.use('/filters', filterRoutes);
router.use('/payments', paymentRoutes);
router.use('/goals', goalRoutes);
router.use('/referrals', referralRoutes);
router.use('/feedback', feedbackRoutes);
router.use('/content', contentRoutes);
router.use('/media', mediaRoutes);
router.use('/stats', statsRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
