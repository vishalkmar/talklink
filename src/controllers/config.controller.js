// GET /config - public app configuration (fetched on splash, no login needed).
const config = require('../config');
const {
  PROFILE_RULES,
  SPIN_SEGMENTS,
  SPINS_PER_DAY,
  FREE_SPINS_PER_DAY,
} = require('../constants/appConfig');
const { AVATAR_IDS, avatarPath } = require('../constants/avatars');
const { RESEND_COOLDOWN_SEC } = require('../services/otp.service');
const { isUpdateRequired } = require('../middlewares/appVersion');

const getConfig = (req, res) => {
  const appVersion = req.get('x-app-version') || req.query.appVersion;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    success: true,
    data: {
      appName: config.appName,
      minAppVersion: config.minAppVersion,
      forceUpdate: isUpdateRequired(appVersion),
      otp: { length: 6, ttlSec: config.otp.ttlSeconds, resendInSec: RESEND_COOLDOWN_SEC },
      profile: PROFILE_RULES,
      avatars: AVATAR_IDS.map((id) => ({ id, url: avatarPath(id) })),
      credits: {
        genderFilterCost: config.economy.genderFilterCost,
        genderFilterPassMin: config.economy.genderFilterPassMin,
        adRewardCredits: config.economy.adRewardCredits,
        dailyAdLimit: config.economy.dailyAdLimit,
        signupBonusCredits: config.economy.signupBonusCredits,
        dailyBonusCredits: config.economy.dailyBonusCredits,
      },
      // Phase 28: the app shows "reward pending" until wallet:updated when SSV is on
      ads: { ssvEnabled: config.admob.ssvEnabled },
      spin: {
        segments: SPIN_SEGMENTS.map((s) => s.credits), // weights stay on the server
        perDay: SPINS_PER_DAY,
        freePerDay: FREE_SPINS_PER_DAY,
      },
    },
  });
};

module.exports = { getConfig };
