const { Schema, model } = require('mongoose');

const TYPES = [
  'signup_bonus',
  'daily_bonus',
  'ad_reward',
  'spin',
  'goal',
  'referral',
  'purchase',
  'gender_filter',
  'refund',
  'admin',
];

// Append-only credits ledger. refId is unique so every grant/debit is idempotent.
const creditTransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true }, // + earn, - spend
    type: { type: String, enum: TYPES, required: true },
    refId: { type: String, required: true, unique: true },
    balanceAfter: { type: Number, required: true },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

creditTransactionSchema.index({ userId: 1, createdAt: -1 });
creditTransactionSchema.statics.TYPES = TYPES;

module.exports = model('CreditTransaction', creditTransactionSchema);
