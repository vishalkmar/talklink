const { Schema, model } = require('mongoose');

// 1-to-1 conversation. participantsKey = sorted "idA:idB" makes find-or-create race-safe.
const conversationSchema = new Schema(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      validate: [(v) => v.length === 2, 'A conversation has exactly 2 participants'],
    },
    participantsKey: { type: String, required: true },
    isRandomSession: { type: Boolean, default: false },
    lastMessage: {
      text: String,
      senderId: { type: Schema.Types.ObjectId, ref: 'User' },
      createdAt: Date,
    },
    unreadCount: { type: Map, of: Number, default: {} }, // userId -> count
    deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    // userId -> when they deleted the chat (23.13): older messages stay hidden for them
    clearedAt: { type: Map, of: Date, default: {} },
    endedAt: { type: Date }, // random session ended (Phase 25) - no more messages
    expiresAt: { type: Date }, // unsaved random sessions are removed after 24h (Phase 25)
  },
  { timestamps: true },
);

// Permanent chats: one per pair. Random sessions can repeat, so they are excluded.
conversationSchema.index(
  { participantsKey: 1 },
  { unique: true, partialFilterExpression: { isRandomSession: false } },
);
conversationSchema.index({ participants: 1, updatedAt: -1 });
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

conversationSchema.statics.keyFor = (a, b) => [String(a), String(b)].sort().join(':');

module.exports = model('Conversation', conversationSchema);
