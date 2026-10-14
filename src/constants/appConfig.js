// Product rules the app reads from GET /config (never hardcoded in the app).
// Economy numbers that ops may tune live in .env (see config/index.js); the rest live here.

const config = require('../config');

const PROFILE_RULES = {
  nameMinLength: 2,
  nameMaxLength: 20,
  genders: ['male', 'female', 'other'],
  genderChangeCooldownDays: 30,
};

// Spin wheel segments (Phase 29). weight = relative probability; the server picks the result.
const SPIN_SEGMENTS = [
  { credits: 10, weight: 24 },
  { credits: 20, weight: 22 },
  { credits: 50, weight: 16 },
  { credits: 100, weight: 10 },
  { credits: 25, weight: 18 },
  { credits: 200, weight: 5 },
  { credits: 15, weight: 4 },
  { credits: 500, weight: 1 },
];

// spins per IST day + how many of them are free (the rest need a rewarded ad) - from .env
const SPINS_PER_DAY = config.economy.spinsPerDay;
const FREE_SPINS_PER_DAY = config.economy.freeSpinsPerDay;

const SEARCH_LIMIT_PER_MIN = 30; // private-number lookups per user per minute

// Direct calls (Phase 22)
const DIRECT_CALLS_PER_HOUR = 20; // 22.12 anti-spam, per caller
// 22.11 "Who can call me directly"
const DIRECT_CALL_PRIVACY = ['everyone', 'past_matches', 'nobody'];

// Reports (Phase 26)
const REPORT_REASONS = ['abuse', 'harassment', 'spam', 'sexual_content', 'underage', 'other'];
const REPORTS_PER_DAY = 10; // per reporter
const AUTO_FLAG_REPORTS = 5; // distinct reporters in 24 h -> flagged + matching paused (26.14)
const AUTO_FLAG_PAUSE_HOURS = 72;

module.exports = {
  PROFILE_RULES,
  SPIN_SEGMENTS,
  SPINS_PER_DAY,
  FREE_SPINS_PER_DAY,
  SEARCH_LIMIT_PER_MIN,
  DIRECT_CALLS_PER_HOUR,
  DIRECT_CALL_PRIVACY,
  REPORT_REASONS,
  REPORTS_PER_DAY,
  AUTO_FLAG_REPORTS,
  AUTO_FLAG_PAUSE_HOURS,
};
