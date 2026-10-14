const { Schema, model } = require('mongoose');

const paymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: String, required: true, unique: true }, // our id, sent to Cashfree
    cfOrderId: { type: String },
    amount: { type: Number, required: true }, // INR rupees
    currency: { type: String, default: 'INR' },
    plan: { type: String, required: true }, // e.g. premium_monthly, credits_12000
    status: {
      type: String,
      enum: ['created', 'pending', 'paid', 'failed', 'cancelled'],
      default: 'created',
    },
    grantedAt: { type: Date }, // set once when premium/credits are granted (idempotency)
    rawWebhook: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

module.exports = model('Payment', paymentSchema);
