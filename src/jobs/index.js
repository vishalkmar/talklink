// Scheduled jobs (node-cron). Started by server.js, never in tests.
// 34.8 several server processes (PM2 cluster / containers) all schedule the same jobs; a Store
// lock per job and minute makes exactly one of them do the work (no double streak resets or
// double 8 PM pushes).
const cron = require('node-cron');
const { store } = require('../config/store');
const config = require('../config');
const logger = require('../utils/logger');
const { captureError } = require('../utils/monitoring');
const presence = require('../services/presence.service');
const payments = require('../services/payment.service');
const gamification = require('../services/gamification.service');

const tasks = [];

const LOCK_TTL_SEC = 55; // shorter than the shortest schedule (every minute)

// true for the one process that may run `name` in this minute
const takeLock = async (name, now = Date.now()) => {
  const slot = Math.floor(now / 60000);
  const ok = await store.set(
    `job:lock:${name}:${slot}`,
    String(process.pid),
    'EX',
    LOCK_TTL_SEC,
    'NX',
  );
  return ok === 'OK';
};

const runSafely = (name, fn) => async () => {
  try {
    if (!(await takeLock(name))) return; // another instance has it
    const result = await fn();
    if (result) logger.info({ job: name, result }, 'Job finished');
  } catch (err) {
    logger.error({ err, job: name }, 'Job failed');
    captureError(err, { job: name });
  }
};

// Free Render instances sleep after 15 min without requests: hit our own public URL.
const keepAlive = async (base = config.keepAlive.url) => {
  const res = await fetch(`${base}/health/ping`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`keep-alive ping answered ${res.status}`);
  return null; // nothing to log when it worked
};

const startJobs = () => {
  // 14.11 every minute: drop users whose heartbeat stopped (killed app, crashed instance).
  tasks.push(cron.schedule('* * * * *', runSafely('presence-cleanup', presence.cleanupStale)));
  // 31.18 premium that ran out (checks also look at premiumUntil, this keeps the flag tidy)
  tasks.push(
    cron.schedule('5 0 * * *', runSafely('premium-expiry', payments.expirePremium), {
      timezone: 'Asia/Kolkata',
    }),
  );
  // 32.3 streaks of people who missed yesterday
  tasks.push(
    cron.schedule('5 0 * * *', runSafely('streak-reset', gamification.resetMissedStreaks), {
      timezone: 'Asia/Kolkata',
    }),
  );
  // 32.14 8 PM reminder when a streak is about to break
  tasks.push(
    cron.schedule('0 20 * * *', runSafely('streak-reminder', gamification.remindStreaks), {
      timezone: 'Asia/Kolkata',
    }),
  );
  if (config.isProd && config.keepAlive.url && config.keepAlive.minutes > 0) {
    tasks.push(
      cron.schedule(
        `*/${config.keepAlive.minutes} * * * *`,
        runSafely('keep-alive', () => keepAlive()),
      ),
    );
  }
  logger.info({ jobs: tasks.length }, 'Scheduled jobs started');
};

const stopJobs = async () => {
  await Promise.all(tasks.map((t) => t.stop()));
  tasks.length = 0;
};

module.exports = { startJobs, stopJobs, runSafely, takeLock, keepAlive };
