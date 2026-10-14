const { Schema, model } = require('mongoose');

const GENDERS = ['male', 'female', 'other'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true, minlength: 2, maxlength: 20 },
    gender: { type: String, enum: GENDERS },
    genderChangedAt: { type: Date }, // gender change lock (Phase 5.5)
    ageConfirmedAt: { type: Date }, // 34.17 ticked "I am 18 or older" at signup
    avatar: { type: String }, // predefined avatar id, e.g. "avatar_07"; null = initial letter
    // Unique in-app number (5-6 digits, stored as string). Assigned by the server only.
    privateNumber: { type: String, required: true, unique: true, immutable: true },
    credits: { type: Number, default: 0, min: 0 },
    isPremium: { type: Boolean, default: false },
    premiumUntil: { type: Date },
    streak: { type: Number, default: 0, min: 0 },
    bestStreak: { type: Number, default: 0, min: 0 },
    // Phase 32: IST day ("2026-10-12") of the last call / chat that counted for the streak
    lastActiveDay: { type: String },
    streakBeforeReset: { type: Number }, // what the nightly reset took away (streak-saver)
    streakResetDay: { type: String }, // IST day of that reset
    streakSaverUsedAt: { type: Date },
    badges: { type: [String], default: [] }, // streak_7, streak_30, ...
    aura: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    fcmToken: { type: String },
    // Indian mobile asked once at checkout (Cashfree requires a customer phone). Never shown to others.
    billingPhone: { type: String },
    // ISO country (26.2 flag on the profile). v1 is India-only, so everyone starts as IN.
    country: { type: String, default: 'IN', uppercase: true, minlength: 2, maxlength: 2 },
    lastSeenAt: { type: Date },
    // Phase 33.8 invite friends: own code (made on first use) + who invited me
    referralCode: { type: String, unique: true, sparse: true, uppercase: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    referredAt: { type: Date },
    settings: {
      // Do Not Disturb (Phase 14.14 / 33.7): no random-match requests in this daily window (IST).
      dnd: {
        enabled: { type: Boolean, default: false },
        start: { type: String, default: '22:00' }, // "HH:mm"
        end: { type: String, default: '07:00' },
      },
      // 33.7 which pushes this user wants (calls = ringing / missed calls while the app is closed)
      notifications: {
        calls: { type: Boolean, default: true },
        messages: { type: Boolean, default: true },
        streakReminders: { type: Boolean, default: true },
        promotions: { type: Boolean, default: false },
      },
      invisible: { type: Boolean, default: false }, // premium "invisible" (14.9) - never in random pools
      // 22.11 who may call me directly (private number / call again)
      // 26.17 strangers (no chat / call with me yet) may start a chat with me
      strangerMessages: { type: Boolean, default: true },
      // 26.18 others see "Active 2h ago"
      showLastSeen: { type: Boolean, default: true },
      directCalls: {
        type: String,
        enum: ['everyone', 'past_matches', 'nobody'],
        default: 'everyone',
      },
    },
    // Set by moderation (many reports, Phase 26.14): excluded from random matching until then.
    matchingPausedUntil: { type: Date },
    // 26.14 many reports in 24 h -> flagged for a human to review
    flaggedAt: { type: Date },
    flagReason: { type: String },
  },
  { timestamps: true },
);

userSchema.virtual('isProfileComplete').get(function isProfileComplete() {
  return Boolean(this.name && this.gender);
});

userSchema.statics.GENDERS = GENDERS;

module.exports = model('User', userSchema);
