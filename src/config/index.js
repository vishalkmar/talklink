// Loads .env and validates every variable with joi. The process exits on boot
// if a required key is missing or malformed, so misconfiguration never reaches runtime.
const path = require('path');
const dotenv = require('dotenv');
const Joi = require('joi');

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// Third-party keys are optional everywhere: the server starts without them and only that feature
// is off (deploy first, fill keys later). In production the missing ones are listed at boot.
const optionalKey = (schema) => schema.allow('').optional();
const FEATURE_KEYS = {
  'Email OTP (Brevo)': ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'],
  'TURN relay for calls': ['TURN_HOST', 'TURN_SECRET'],
  'Push notifications (Firebase)': ['FIREBASE_SERVICE_ACCOUNT'],
  'Payments (Cashfree)': ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY'],
};

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(4000),
  APP_NAME: Joi.string().default('TalkLink'),
  APP_VERSION: Joi.string().default('1.0.0'),

  MONGO_URI: Joi.string()
    .uri({ scheme: ['mongodb', 'mongodb+srv'] })
    .required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('30d'),

  BREVO_API_KEY: optionalKey(Joi.string()),
  BREVO_SENDER_EMAIL: optionalKey(Joi.string().email()),
  BREVO_SENDER_NAME: Joi.string().default('TalkLink'),
  OTP_TTL_SECONDS: Joi.number().integer().min(60).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  DEV_OTP_BYPASS: Joi.boolean().default(false),

  TURN_HOST: optionalKey(Joi.string()),
  TURN_SECRET: optionalKey(Joi.string()),
  TURN_TTL: Joi.number().integer().default(3600),
  CALL_MAX_DURATION_MIN: Joi.number().integer().min(1).default(120),
  AURA_PER_MINUTE: Joi.number().integer().min(0).default(1),
  PEER_LOST_GRACE_SEC: Joi.number().integer().min(1).default(15),
  RING_TIMEOUT_SEC: Joi.number().integer().min(5).max(120).default(30),
  // Gamification (Phase 32)
  STREAK_MIN_SECONDS: Joi.number().integer().min(1).default(60), // a call / chat this long counts
  STREAK_WEEK_BONUS_CREDITS: Joi.number().integer().min(0).default(200), // every 7th day
  STREAK_SAVER_DAYS: Joi.number().integer().min(1).default(7), // one streak-saver per N days
  AURA_PER_GOOD_RATING: Joi.number().integer().min(0).default(2), // 4-5 star rating received

  FIREBASE_SERVICE_ACCOUNT: optionalKey(Joi.string()),
  ADMOB_SSV_ENABLED: Joi.boolean().default(true),
  // Google's public keys for rewarded-ad server-side verification (rarely changes)
  ADMOB_SSV_KEYS_URL: Joi.string()
    .uri()
    .default('https://www.gstatic.com/admob/reward/verifier-keys.json'),
  // comma-separated real rewarded ad unit ids; empty = accept any (dev / test ids)
  ADMOB_AD_UNIT_IDS: Joi.string().allow('').default(''),

  CASHFREE_APP_ID: optionalKey(Joi.string()),
  CASHFREE_SECRET_KEY: optionalKey(Joi.string()),
  CASHFREE_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  CASHFREE_ENV: Joi.string().valid('sandbox', 'production').default('sandbox'),
  CASHFREE_API_VERSION: Joi.string().allow('').default('2023-08-01'),
  CASHFREE_RETURN_URL: Joi.string().uri().allow('').optional(),
  // public URL Cashfree posts payment webhooks to (https://api.yourdomain.com/api/v1/payments/webhook)
  CASHFREE_NOTIFY_URL: Joi.string().uri().allow('').optional(),
  // Plans (Phase 31) - prices in INR
  PREMIUM_WEEKLY_PRICE: Joi.number().min(1).default(49),
  PREMIUM_MONTHLY_PRICE: Joi.number().min(1).default(149),
  PREMIUM_YEARLY_PRICE: Joi.number().min(1).default(999),
  // "credits:price,..." e.g. 5000:49,12000:99,30000:199
  CREDIT_PACKS: Joi.string()
    .pattern(/^\d+:\d+(\.\d+)?(,\d+:\d+(\.\d+)?)*$/)
    .default('5000:49,12000:99,30000:199'),
  PREMIUM_EXTRA_SPINS: Joi.number().integer().min(0).default(3),

  GENDER_FILTER_COST: Joi.number().integer().min(0).default(10000),
  GENDER_FILTER_PASS_MIN: Joi.number().integer().min(1).max(1440).default(30),
  AD_REWARD_CREDITS: Joi.number().integer().min(0).default(500),
  DAILY_AD_LIMIT: Joi.number().integer().min(0).default(20),
  SIGNUP_BONUS_CREDITS: Joi.number().integer().min(0).default(100),
  DAILY_BONUS_CREDITS: Joi.number().integer().min(0).default(20),
  SPINS_PER_DAY: Joi.number().integer().min(0).max(50).default(5),
  FREE_SPINS_PER_DAY: Joi.number().integer().min(0).max(50).default(1),
  REWARD_ABUSE_LIMIT: Joi.number().integer().min(1).default(15), // earn events per 10 min
  // 30.16 no ad rewards on emulators (the app reports it; turn off to test on an emulator)
  REWARDS_BLOCK_EMULATORS: Joi.boolean().default(true),
  // Phase 33 invite friends: both get this many credits when the friend enters the code
  REFERRAL_BONUS_CREDITS: Joi.number().integer().min(0).default(200),
  REFERRAL_MAX_PER_DAY: Joi.number().integer().min(1).default(20), // per inviter
  REFERRAL_WINDOW_DAYS: Joi.number().integer().min(1).default(7), // new accounts only
  // {code} is replaced; empty = the Play Store page with the code as install referrer
  INVITE_URL: Joi.string().allow('').default(''),
  // Contact Us (33.12): where feedback is emailed (empty = stored in the DB only)
  FEEDBACK_TO_EMAIL: Joi.string().email().allow('').default(''),
  SUPPORT_EMAIL: Joi.string().email().allow('').default(''),
  ANDROID_PACKAGE: Joi.string().default('com.talklink.app'),
  MIN_APP_VERSION: Joi.string()
    .pattern(/^\d+\.\d+\.\d+$/)
    .default('1.0.0'),

  ADMIN_API_KEY: Joi.string().min(24).allow('').optional(),
  SENTRY_DSN: Joi.string().allow('').optional(),
  // 34.4 share of requests traced for performance (0 = errors only)
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(0),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // proxy hops in front of the app in production (Render: 1)
  TRUST_PROXY: Joi.number().integer().min(0).max(5).default(1),
  // optional DNS servers for lookups (e.g. mongodb+srv on a PC whose local DNS refuses SRV queries)
  DNS_SERVERS: Joi.string().allow('').default(''),
  // keep a free Render instance awake: ping <url>/health/ping every N minutes (production only).
  // Empty -> Render's own RENDER_EXTERNAL_URL; set KEEP_ALIVE_MINUTES=0 to switch it off.
  KEEP_ALIVE_URL: Joi.string().uri().allow('').default(''),
  RENDER_EXTERNAL_URL: Joi.string().allow('').default(''),
  KEEP_ALIVE_MINUTES: Joi.number().integer().min(0).max(14).default(10),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent', '')
    .optional(),
}).unknown(true);

const { value: env, error } = schema.validate(process.env, { abortEarly: false, convert: true });

if (error) {
  console.error('Invalid environment configuration:');
  error.details.forEach((d) => console.error(`  - ${d.message}`));
  process.exit(1);
}

if (env.NODE_ENV === 'production' && env.DEV_OTP_BYPASS) {
  console.error('DEV_OTP_BYPASS must be false in production');
  process.exit(1);
}

if (env.NODE_ENV === 'production') {
  Object.entries(FEATURE_KEYS).forEach(([feature, keys]) => {
    const missing = keys.filter((k) => !env[k]);
    if (missing.length) console.error(`[config] ${feature} is OFF - set ${missing.join(', ')}`);
  });
}

const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  appName: env.APP_NAME,
  appVersion: env.APP_VERSION,
  logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  mongo: { uri: env.MONGO_URI },

  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
  },

  brevo: {
    apiKey: env.BREVO_API_KEY,
    senderEmail: env.BREVO_SENDER_EMAIL,
    senderName: env.BREVO_SENDER_NAME,
  },
  otp: {
    ttlSeconds: env.OTP_TTL_SECONDS,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    devBypass: env.DEV_OTP_BYPASS && env.NODE_ENV !== 'production',
  },

  turn: { host: env.TURN_HOST, secret: env.TURN_SECRET, ttl: env.TURN_TTL },
  calls: {
    maxDurationMin: env.CALL_MAX_DURATION_MIN,
    auraPerMinute: env.AURA_PER_MINUTE,
    peerLostGraceSec: env.PEER_LOST_GRACE_SEC,
    ringTimeoutSec: env.RING_TIMEOUT_SEC,
  },
  gamification: {
    streakMinSeconds: env.STREAK_MIN_SECONDS,
    weekBonusCredits: env.STREAK_WEEK_BONUS_CREDITS,
    saverDays: env.STREAK_SAVER_DAYS,
    auraPerGoodRating: env.AURA_PER_GOOD_RATING,
  },
  firebase: { serviceAccount: env.FIREBASE_SERVICE_ACCOUNT },
  admob: {
    ssvEnabled: env.ADMOB_SSV_ENABLED,
    ssvKeysUrl: env.ADMOB_SSV_KEYS_URL,
    adUnitIds: env.ADMOB_AD_UNIT_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  cashfree: {
    appId: env.CASHFREE_APP_ID,
    secretKey: env.CASHFREE_SECRET_KEY,
    webhookSecret: env.CASHFREE_WEBHOOK_SECRET,
    env: env.CASHFREE_ENV,
    apiVersion: env.CASHFREE_API_VERSION,
    returnUrl: env.CASHFREE_RETURN_URL,
    notifyUrl: env.CASHFREE_NOTIFY_URL,
  },

  economy: {
    genderFilterCost: env.GENDER_FILTER_COST,
    genderFilterPassMin: env.GENDER_FILTER_PASS_MIN,
    adRewardCredits: env.AD_REWARD_CREDITS,
    dailyAdLimit: env.DAILY_AD_LIMIT,
    signupBonusCredits: env.SIGNUP_BONUS_CREDITS,
    dailyBonusCredits: env.DAILY_BONUS_CREDITS,
    spinsPerDay: env.SPINS_PER_DAY,
    freeSpinsPerDay: env.FREE_SPINS_PER_DAY,
    rewardAbuseLimit: env.REWARD_ABUSE_LIMIT,
    blockEmulators: env.REWARDS_BLOCK_EMULATORS,
  },
  plans: {
    premiumWeekly: env.PREMIUM_WEEKLY_PRICE,
    premiumMonthly: env.PREMIUM_MONTHLY_PRICE,
    premiumYearly: env.PREMIUM_YEARLY_PRICE,
    creditPacks: env.CREDIT_PACKS.split(',').map((p) => {
      const [credits, price] = p.split(':');
      return { credits: Number(credits), price: Number(price) };
    }),
    premiumExtraSpins: env.PREMIUM_EXTRA_SPINS,
  },
  referral: {
    bonusCredits: env.REFERRAL_BONUS_CREDITS,
    maxPerDay: env.REFERRAL_MAX_PER_DAY,
    windowDays: env.REFERRAL_WINDOW_DAYS,
    inviteUrl: env.INVITE_URL,
  },
  support: { feedbackTo: env.FEEDBACK_TO_EMAIL, email: env.SUPPORT_EMAIL },
  androidPackage: env.ANDROID_PACKAGE,
  trustProxy: env.TRUST_PROXY,
  keepAlive: {
    url: (env.KEEP_ALIVE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    minutes: env.KEEP_ALIVE_MINUTES,
  },
  dnsServers: env.DNS_SERVERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  minAppVersion: env.MIN_APP_VERSION,
  adminApiKey: env.ADMIN_API_KEY || '',
  sentryDsn: env.SENTRY_DSN,
  sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
};

module.exports = Object.freeze(config);
