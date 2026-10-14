// Reports (Phase 26.12 - 26.14). A report also blocks the person for the reporter (26.13).
// 5+ different reporters within 24 h -> the reported user is flagged for review and paused from
// random matching for AUTO_FLAG_PAUSE_HOURS (14.15 already skips paused users).
const mongoose = require('mongoose');
const Report = require('../models/Report');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { store } = require('../config/store');
const {
  REPORTS_PER_DAY,
  AUTO_FLAG_REPORTS,
  AUTO_FLAG_PAUSE_HOURS,
} = require('../constants/appConfig');
const { blockUser } = require('./block.service');

const settings = {
  perDay: REPORTS_PER_DAY,
  flagThreshold: AUTO_FLAG_REPORTS,
  pauseHours: AUTO_FLAG_PAUSE_HOURS,
};
const DAY_MS = 24 * 3600 * 1000;

const checkReporterLimit = async (reporterId) => {
  const key = `rl:reports:${reporterId}`;
  const n = await store.incr(key);
  if (n === 1) await store.expire(key, 24 * 3600);
  if (n > settings.perDay) {
    throw ApiError.tooMany('You have sent many reports today. Try again tomorrow.', 'RATE_LIMITED');
  }
};

// 26.14
const maybeFlag = async (reportedId) => {
  const since = new Date(Date.now() - DAY_MS);
  const reporters = await Report.distinct('reporterId', {
    reportedId,
    createdAt: { $gte: since },
  });
  if (reporters.length < settings.flagThreshold) return false;
  const until = new Date(Date.now() + settings.pauseHours * 3600 * 1000);
  const res = await User.updateOne(
    { _id: reportedId, flaggedAt: { $exists: false } },
    {
      $set: {
        flaggedAt: new Date(),
        flagReason: `${reporters.length} reports in 24h`,
        matchingPausedUntil: until,
      },
    },
  );
  if (res.modifiedCount) {
    logger.warn({ reportedId: String(reportedId), reports: reporters.length }, 'User auto-flagged');
  }
  return true;
};

const createReport = async (reporterId, { userId, reason, note, callId, conversationId }) => {
  if (!mongoose.isValidObjectId(userId))
    throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (String(userId) === String(reporterId)) {
    throw ApiError.badRequest('You cannot report yourself', 'CANNOT_REPORT_SELF');
  }
  if (!(await User.exists({ _id: userId, status: { $ne: 'deleted' } }))) {
    throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  }
  await checkReporterLimit(String(reporterId));
  const report = await Report.create({
    reporterId,
    reportedId: userId,
    reason,
    note: note || undefined,
    callId: mongoose.isValidObjectId(callId) ? callId : undefined,
    conversationId: mongoose.isValidObjectId(conversationId) ? conversationId : undefined,
  });
  await blockUser(reporterId, userId); // 26.13 also ends a live call / session
  const flagged = await maybeFlag(userId);
  logger.info({ reportId: String(report._id), reason }, 'User reported');
  return { reported: true, blocked: true, reportId: String(report._id), flagged };
};

module.exports = { settings, createReport };
