// Public app content (Phase 33.9): FAQ text with live numbers filled in. No login needed.
const { Router } = require('express');
const config = require('../config');
const { FAQ } = require('../constants/faq');

const router = Router();

const fill = (text) =>
  text.replace(/\{(\w+)\}/g, (all, key) => {
    const values = {
      appName: config.appName,
      referralBonus: config.referral.bonusCredits,
      genderFilterCost: config.economy.genderFilterCost.toLocaleString('en-IN'),
      genderFilterPassMin: config.economy.genderFilterPassMin,
    };
    return values[key] === undefined ? all : String(values[key]);
  });

router.get('/faq', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    success: true,
    data: {
      items: FAQ.map((f) => ({ id: f.id, q: fill(f.q), a: fill(f.a) })),
      supportEmail: config.support.email || null,
    },
  });
});

module.exports = router;
