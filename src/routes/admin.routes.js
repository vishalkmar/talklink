// Admin / ops endpoints (X-Admin-Key). The web admin panel is out of scope for v1 - APIs only.
const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireAdmin = require('../middlewares/requireAdmin');
const crypto = require('crypto');
const Joi = require('joi');
const mongoose = require('mongoose');
const validate = require('../middlewares/validate');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const presence = require('../services/presence.service');
const wallet = require('../services/wallet.service');
const tokenService = require('../services/token.service');
const emitter = require('../sockets/emitter');
const { User, Report } = require('../models');
const { toPublicUser } = require('../utils/serializers');

const router = Router();

router.use(requireAdmin);

// 14.18 presence counts (debugging matchmaking supply).
router.get(
  '/presence',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await presence.debugCounts() });
  }),
);

// 27.15 support: grant (or take back) credits. Send the same refId again to retry safely.
router.post(
  '/users/:id/credits',
  validate({
    params: Joi.object({ id: Joi.string().max(64).required() }),
    body: Joi.object({
      amount: Joi.number().integer().invalid(0).min(-1000000).max(1000000).required(),
      reason: Joi.string().trim().min(3).max(200).required(),
      refId: Joi.string().max(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
    const { amount, reason } = req.valid.body;
    const refId = `admin:${req.valid.body.refId || crypto.randomUUID()}`;
    const op = amount > 0 ? wallet.credit : wallet.debit;
    const result = await op({
      userId: id,
      amount: Math.abs(amount),
      type: 'admin',
      refId,
      meta: { reason },
    });
    logger.warn({ userId: id, amount, reason, refId }, 'Admin credit change'); // audit trail
    res.json({
      success: true,
      data: { applied: result.applied, balance: result.balance, refId },
    });
  }),
);

// ---------- 34.3 moderation (Play UGC policy: reports must be reviewed and acted on) ----------

const idParam = { params: Joi.object({ id: Joi.string().max(64).required() }) };
const findUser = async (id) => {
  const user = mongoose.isValidObjectId(id) ? await User.findById(id) : null;
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  return user;
};
const brief = (u) => (u ? { ...toPublicUser(u), status: u.status, flaggedAt: u.flaggedAt } : null);

// review queue, newest first: ?status=open|reviewed|actioned|dismissed (default open)
router.get(
  '/reports',
  validate({
    query: Joi.object({
      status: Joi.string()
        .valid(...['open', 'reviewed', 'actioned', 'dismissed'])
        .default('open'),
      limit: Joi.number().integer().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, limit } = req.valid.query;
    const reports = await Report.find({ status }).sort({ createdAt: -1 }).limit(limit).lean();
    const ids = [...new Set(reports.flatMap((r) => [String(r.reporterId), String(r.reportedId)]))];
    const users = new Map(
      (await User.find({ _id: { $in: ids } }).lean()).map((u) => [String(u._id), u]),
    );
    res.json({
      success: true,
      data: {
        items: reports.map((r) => ({
          id: String(r._id),
          reason: r.reason,
          note: r.note || null,
          status: r.status,
          callId: r.callId ? String(r.callId) : null,
          conversationId: r.conversationId ? String(r.conversationId) : null,
          createdAt: r.createdAt,
          reporter: brief(users.get(String(r.reporterId))),
          reported: brief(users.get(String(r.reportedId))),
        })),
      },
    });
  }),
);

router.patch(
  '/reports/:id',
  validate({
    ...idParam,
    body: Joi.object({
      status: Joi.string().valid('reviewed', 'actioned', 'dismissed').required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const report = mongoose.isValidObjectId(id)
      ? await Report.findByIdAndUpdate(
          id,
          { status: req.valid.body.status },
          { returnDocument: 'after' },
        )
      : null;
    if (!report) throw ApiError.notFound('Report not found', 'REPORT_NOT_FOUND');
    logger.warn({ reportId: id, status: report.status }, 'Admin report update');
    res.json({ success: true, data: { id, status: report.status } });
  }),
);

// users flagged by many reports (26.14), newest first
router.get(
  '/users/flagged',
  asyncHandler(async (req, res) => {
    const users = await User.find({ flaggedAt: { $exists: true } })
      .sort({ flaggedAt: -1 })
      .limit(100)
      .lean();
    const counts = await Report.aggregate([
      { $match: { reportedId: { $in: users.map((u) => u._id) } } },
      {
        $group: {
          _id: '$reportedId',
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
        },
      },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    res.json({
      success: true,
      data: {
        items: users.map((u) => ({
          ...brief(u),
          flagReason: u.flagReason || null,
          matchingPausedUntil: u.matchingPausedUntil || null,
          reports: {
            total: (byId.get(String(u._id)) || {}).total || 0,
            open: (byId.get(String(u._id)) || {}).open || 0,
          },
        })),
      },
    });
  }),
);

// suspend: can't log in or connect; every session revoked; open reports -> actioned
router.post(
  '/users/:id/suspend',
  validate({
    ...idParam,
    body: Joi.object({ reason: Joi.string().trim().min(3).max(200).required() }),
  }),
  asyncHandler(async (req, res) => {
    const user = await findUser(req.valid.params.id);
    if (user.status === 'deleted') throw ApiError.conflict('Account is deleted', 'USER_DELETED');
    await User.updateOne(
      { _id: user._id },
      { $set: { status: 'suspended', flagReason: req.valid.body.reason } },
    );
    await Promise.all([
      tokenService.revokeAllForUser(user._id),
      Report.updateMany({ reportedId: user._id, status: 'open' }, { $set: { status: 'actioned' } }),
    ]);
    emitter.disconnectUser(String(user._id));
    logger.warn(
      { userId: String(user._id), reason: req.valid.body.reason },
      'Admin suspended user',
    );
    res.json({ success: true, data: { id: String(user._id), status: 'suspended' } });
  }),
);

// lift a suspension / clear a flag (wrong reports)
router.post(
  '/users/:id/unsuspend',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const user = await findUser(req.valid.params.id);
    if (user.status === 'deleted') throw ApiError.conflict('Account is deleted', 'USER_DELETED');
    await User.updateOne(
      { _id: user._id },
      {
        $set: { status: 'active' },
        $unset: { flaggedAt: 1, flagReason: 1, matchingPausedUntil: 1 },
      },
    );
    logger.warn({ userId: String(user._id) }, 'Admin lifted suspension / flag');
    res.json({ success: true, data: { id: String(user._id), status: 'active' } });
  }),
);

module.exports = router;
