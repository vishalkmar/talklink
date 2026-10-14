const { Schema, model } = require('mongoose');

const REASONS = ['abuse', 'harassment', 'spam', 'sexual_content', 'underage', 'other'];

const reportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reportedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REASONS, required: true },
    note: { type: String, maxlength: 500 },
    callId: { type: Schema.Types.ObjectId, ref: 'Call' },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' }, // reported from a chat
    status: {
      type: String,
      enum: ['open', 'reviewed', 'actioned', 'dismissed'],
      default: 'open',
    },
  },
  { timestamps: true },
);

reportSchema.index({ reportedId: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 }); // review queue
reportSchema.statics.REASONS = REASONS;

module.exports = model('Report', reportSchema);
