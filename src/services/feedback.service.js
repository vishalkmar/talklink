// Contact Us / "Get in Touch" (Phase 33.11 / 33.12): saved as a Feedback document and copied to
// the team inbox (FEEDBACK_TO_EMAIL) through Brevo. The email is best effort - the document is
// the record. 5 messages per user per hour.
const config = require('../config');
const { redis } = require('../config/redis');
const Feedback = require('../models/Feedback');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const mail = require('./mail.service');

const settings = { perHour: 5, feedbackTo: config.support.feedbackTo };

const TYPE_LABEL = { feedback: 'Feedback', problem: 'Problem', idea: 'Idea' };

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const emailTeam = async (doc, user) => {
  if (!settings.feedbackTo || !mail.isConfigured()) return false;
  const label = TYPE_LABEL[doc.type];
  const lines = [
    ['Type', label],
    ['From', `${user.name || '-'} (#${user.privateNumber}) <${user.email}>`],
    ['Contact given', doc.contact || '-'],
    ['App', `${doc.appVersion || '-'} ${doc.platform || ''}`.trim()],
    ['Feedback id', String(doc._id)],
  ];
  const text = `${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${doc.message}`;
  const html = `<table>${lines
    .map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`)
    .join('')}</table><p style="white-space:pre-wrap">${escapeHtml(doc.message)}</p>`;
  await mail.sendEmail({
    to: settings.feedbackTo,
    subject: `[${config.appName} ${label}] ${doc.message.slice(0, 60)}`,
    text,
    html,
    tags: ['feedback', doc.type],
    replyTo: user.email,
  });
  return true;
};

const submit = async (user, { type, message, contact }, { appVersion, platform } = {}) => {
  const key = `feedback:hour:${user._id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  if (count > settings.perHour) {
    throw ApiError.tooMany(
      'You sent a lot of messages. Please try again in a while.',
      'FEEDBACK_LIMIT',
    );
  }
  const doc = await Feedback.create({
    userId: user._id,
    type,
    message,
    contact: contact || undefined,
    appVersion,
    platform,
  });
  try {
    if (await emailTeam(doc, user)) {
      await Feedback.updateOne({ _id: doc._id }, { $set: { emailedAt: new Date() } });
    }
  } catch (err) {
    logger.warn(
      { err: err.code || err.message, feedbackId: String(doc._id) },
      'Feedback email failed',
    );
  }
  return { id: String(doc._id), received: true };
};

module.exports = { settings, submit };
