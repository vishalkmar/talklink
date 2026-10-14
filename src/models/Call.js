const { Schema, model } = require('mongoose');

// One document per audio call or random text session ("call history" in the app).
const callSchema = new Schema(
  {
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    calleeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, enum: ['audio', 'text'], required: true },
    matchType: { type: String, enum: ['random', 'direct'], required: true },
    status: {
      type: String,
      enum: ['ringing', 'active', 'ended', 'missed', 'declined', 'cancelled'],
      default: 'ringing',
    },
    startedAt: { type: Date }, // when both sides connected
    endedAt: { type: Date },
    durationSec: { type: Number, default: 0 },
    endReason: { type: String }, // hangup | peer_lost | timeout | blocked | max_duration ...
    auraEarned: { type: Number, default: 0 },
    hiddenFor: [{ type: Schema.Types.ObjectId, ref: 'User' }], // "delete from my history"
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' }, // text sessions (Phase 25)
    // 20.10 "Rate call" - one rating per participant, only for calls that connected
    ratings: [
      {
        _id: false,
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        stars: { type: Number, min: 1, max: 5, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

callSchema.index({ callerId: 1, createdAt: -1 });
callSchema.index({ calleeId: 1, createdAt: -1 });

module.exports = model('Call', callSchema);
