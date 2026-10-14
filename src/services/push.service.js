// Push notifications through Firebase Cloud Messaging (Phase 21).
// Only DATA messages with high priority are sent: the app decides what to show (full-screen
// incoming call, remove it, missed-call notification). Payload formats: docs/SOCKET_EVENTS.md
// "Push messages". Without FIREBASE_SERVICE_ACCOUNT (local dev / tests) pushes are skipped.
const fs = require('node:fs');
const config = require('../config');
const logger = require('../utils/logger');
const User = require('../models/User');
const { registerCheck } = require('./health.service');
const { notificationSettings } = require('../utils/serializers');

const PUSH = {
  INCOMING_CALL: 'incoming_call',
  CALL_CANCELLED: 'call_cancelled',
  MISSED_CALL: 'missed_call',
  NEW_MESSAGE: 'new_message', // Phase 23.14
  STREAK_REMINDER: 'streak_reminder', // Phase 32.14
};

// 33.7 the setting that can switch a push type off (cancel pushes always go out)
const SETTING_FOR = {
  [PUSH.INCOMING_CALL]: 'calls',
  [PUSH.MISSED_CALL]: 'calls',
  [PUSH.NEW_MESSAGE]: 'messages',
  [PUSH.STREAK_REMINDER]: 'streakReminders',
};

let transport = null; // async ({ token, data, ttlMs }) => messageId
let initialised = false;

// FIREBASE_SERVICE_ACCOUNT = path to the JSON file, base64 of it, or the raw JSON.
const readServiceAccount = (value) => {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.startsWith('{')) return JSON.parse(v);
  if (fs.existsSync(v)) return JSON.parse(fs.readFileSync(v, 'utf8'));
  return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
};

const initPush = () => {
  if (initialised) return Boolean(transport);
  initialised = true;
  let account;
  try {
    account = readServiceAccount(config.firebase.serviceAccount);
  } catch (err) {
    logger.error(
      { err: err.message },
      'FIREBASE_SERVICE_ACCOUNT is not valid JSON / path / base64',
    );
    return false;
  }
  if (!account) {
    logger.warn('Push disabled: FIREBASE_SERVICE_ACCOUNT not set');
    return false;
  }
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');
  const app = initializeApp({ credential: cert(account) }, 'talklink-push');
  const messaging = getMessaging(app);
  transport = ({ token, data, ttlMs }) =>
    messaging.send({
      token,
      data,
      android: { priority: 'high', ttl: ttlMs },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'background' } },
    });
  registerCheck('push', async () => 'up'); // only when configured (disabled must not mark /health degraded)
  logger.info({ projectId: account.project_id }, 'Push enabled (FCM)');
  return true;
};

// FCM data values must be strings.
const stringify = (data) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );

const DEAD_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
];

// Sends one data message to the user's device. Never throws: returns { sent, reason }.
const sendToUser = async (userId, type, data = {}, { ttlSec = 60 } = {}) => {
  if (!initialised) initPush();
  if (!transport) return { sent: false, reason: 'disabled' };
  const user = await User.findById(userId).select('fcmToken status settings').lean();
  if (!user || user.status !== 'active') return { sent: false, reason: 'no_user' };
  if (!user.fcmToken) return { sent: false, reason: 'no_token' };
  const setting = SETTING_FOR[type];
  if (setting && !notificationSettings(user)[setting]) return { sent: false, reason: 'muted' };
  try {
    const id = await transport({
      token: user.fcmToken,
      data: stringify({ type, ...data, sentAt: Date.now() }),
      ttlMs: ttlSec * 1000,
    });
    logger.debug({ userId: String(userId), type, id }, 'Push sent');
    return { sent: true };
  } catch (err) {
    const code = err && (err.code || (err.errorInfo && err.errorInfo.code));
    if (DEAD_TOKEN_CODES.includes(code)) {
      await User.updateOne({ _id: userId, fcmToken: user.fcmToken }, { $unset: { fcmToken: 1 } });
    }
    logger.warn({ userId: String(userId), type, code }, 'Push failed');
    return { sent: false, reason: code || 'error' };
  }
};

// tests: replace FCM with a fake (null = disabled)
const __setTransportForTests = (fn) => {
  initialised = true;
  transport = fn;
};

module.exports = { PUSH, initPush, sendToUser, readServiceAccount, __setTransportForTests };
