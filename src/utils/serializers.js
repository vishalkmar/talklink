// Shapes user documents for API responses. Never return raw documents.

// 33.7 defaults: everything on except promotions
const NOTIFICATION_DEFAULTS = {
  calls: true,
  messages: true,
  streakReminders: true,
  promotions: false,
};
const notificationSettings = (u) => {
  const n = (u.settings && u.settings.notifications) || {};
  return Object.fromEntries(
    Object.entries(NOTIFICATION_DEFAULTS).map(([k, d]) => [
      k,
      typeof n[k] === 'boolean' ? n[k] : d,
    ]),
  );
};

// The signed-in user's own profile.
const toPrivateUser = (u) => ({
  id: String(u._id),
  email: u.email,
  name: u.name || null,
  gender: u.gender || null,
  avatar: u.avatar || null,
  privateNumber: u.privateNumber,
  credits: u.credits,
  isPremium: Boolean(u.isPremium && (!u.premiumUntil || u.premiumUntil > new Date())),
  premiumUntil: u.premiumUntil || null,
  hasBillingPhone: Boolean(u.billingPhone),
  streak: u.streak,
  bestStreak: u.bestStreak,
  aura: u.aura,
  isProfileComplete: Boolean(u.name && u.gender),
  genderChangedAt: u.genderChangedAt || null,
  ageConfirmed: Boolean(u.ageConfirmedAt),
  country: u.country || 'IN',
  settings: {
    directCalls: (u.settings && u.settings.directCalls) || 'everyone',
    strangerMessages: !(u.settings && u.settings.strangerMessages === false),
    showLastSeen: !(u.settings && u.settings.showLastSeen === false),
    notifications: notificationSettings(u),
    dnd: {
      enabled: Boolean(u.settings && u.settings.dnd && u.settings.dnd.enabled),
      start: (u.settings && u.settings.dnd && u.settings.dnd.start) || '22:00',
      end: (u.settings && u.settings.dnd && u.settings.dnd.end) || '07:00',
    },
  },
  referred: Boolean(u.referredBy),
  createdAt: u.createdAt,
});

// What other users may see (no email, credits, tokens or premium details).
const toPublicUser = (u) => ({
  id: String(u._id),
  name: u.name || null,
  gender: u.gender || null,
  avatar: u.avatar || null,
  privateNumber: u.privateNumber,
  country: u.country || 'IN',
  // 31.15 premium badge
  premium: Boolean(u.isPremium && (!u.premiumUntil || u.premiumUntil > new Date())),
  streak: u.streak,
  bestStreak: u.bestStreak,
  aura: u.aura,
  joinedAt: u.createdAt,
});

module.exports = { toPrivateUser, toPublicUser, notificationSettings };
