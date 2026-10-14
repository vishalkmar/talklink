// Error reporting (Phase 34.4) with Sentry. Off unless SENTRY_DSN is set. Only real failures are
// sent (5xx, crashes, failed jobs) - never request bodies, emails, tokens or OTPs.
const Sentry = require('@sentry/node');
const config = require('../config');

let enabled = false;

const SECRET_KEYS = /authorization|cookie|token|otp|password|secret|email|phone|x-admin-key/i;

// drop anything personal before it leaves the server
const scrub = (event) => {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      Object.keys(event.request.headers).forEach((h) => {
        if (SECRET_KEYS.test(h)) delete event.request.headers[h];
      });
    }
    if (event.request.query_string) event.request.query_string = '[removed]';
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
};

const initMonitoring = () => {
  if (!config.sentryDsn || config.isTest) return false;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    release: `talklink-server@${config.appVersion}`,
    sendDefaultPii: false,
    tracesSampleRate: config.sentryTracesSampleRate,
    beforeSend: scrub,
  });
  enabled = true;
  return true;
};

// context: { userId, requestId, job, path, ... } (ids only)
const captureError = (err, context = {}) => {
  if (!enabled) return null;
  return Sentry.withScope((scope) => {
    if (context.userId) scope.setUser({ id: String(context.userId) });
    Object.entries(context).forEach(([k, v]) => {
      if (k !== 'userId' && v !== undefined) scope.setTag(k, String(v));
    });
    return Sentry.captureException(err);
  });
};

const flushMonitoring = async (ms = 2000) => {
  if (enabled) await Sentry.flush(ms);
};

module.exports = { initMonitoring, captureError, flushMonitoring, scrub };
