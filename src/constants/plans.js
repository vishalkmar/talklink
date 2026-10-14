// What can be bought (Phase 31.3). Prices come from .env (config.plans) - never from the app.
const config = require('../config');

const PREMIUM_BENEFITS = [
  'Gender filter free',
  'No ads - credits without videos',
  'Premium badge on your profile',
  'Priority in random matching',
  `${config.plans.premiumExtraSpins} more spins a day, all free`,
];

const PLANS = [
  {
    id: 'premium_weekly',
    kind: 'premium',
    days: 7,
    price: config.plans.premiumWeekly,
    label: 'Weekly',
  },
  {
    id: 'premium_monthly',
    kind: 'premium',
    days: 30,
    price: config.plans.premiumMonthly,
    label: 'Monthly',
  },
  {
    id: 'premium_yearly',
    kind: 'premium',
    days: 365,
    price: config.plans.premiumYearly,
    label: 'Yearly',
  },
  ...config.plans.creditPacks.map((p) => ({
    id: `credits_${p.credits}`,
    kind: 'credits',
    credits: p.credits,
    price: p.price,
    label: `${p.credits.toLocaleString('en-IN')} credits`,
  })),
];

const planById = (id) => PLANS.find((p) => p.id === id) || null;

module.exports = { PLANS, PREMIUM_BENEFITS, planById };
