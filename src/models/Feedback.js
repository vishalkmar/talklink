const { Schema, model } = require('mongoose');

// Contact Us ("Get in Touch") submissions (Phase 33.12).
const feedbackSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['feedback', 'problem', 'idea'], required: true },
    message: { type: String, required: true, maxlength: 2000 },
    contact: { type: String, maxlength: 120 }, // optional email / phone to reply to
    appVersion: { type: String, maxlength: 20 },
    platform: { type: String, maxlength: 20 },
    emailedAt: { type: Date }, // copy sent to FEEDBACK_TO_EMAIL
    status: { type: String, enum: ['new', 'seen', 'closed'], default: 'new' },
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });

module.exports = model('Feedback', feedbackSchema);
