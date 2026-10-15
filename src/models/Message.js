const { Schema, model } = require('mongoose');

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User' }, // null for system messages
    text: { type: String, maxlength: 1000, default: '' },
    type: { type: String, enum: ['text', 'audio', 'system'], default: 'text' },
    // Phase 36 voice message (Cloudinary); url / publicId are removed when the file is purged
    audio: {
      url: { type: String },
      publicId: { type: String },
      durationSec: { type: Number },
    },
    // Phase 36 view once: content is shown to the receiver one time, then wiped
    viewOnce: { type: Boolean, default: false },
    openedAt: { type: Date },
    mediaPurgeAt: { type: Date }, // when to delete the audio file from Cloudinary
    status: { type: String, enum: ['sent', 'delivered', 'seen'], default: 'sent' },
    clientMsgId: { type: String }, // client-generated id, dedupes resends (Phase 23.15)
    deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    deliveredAt: { type: Date },
    seenAt: { type: Date },
    expiresAt: { type: Date }, // 23.16 ephemeral random-session messages (TTL)
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
messageSchema.index({ mediaPurgeAt: 1 }, { sparse: true });
messageSchema.index(
  { senderId: 1, clientMsgId: 1 },
  { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } },
);

module.exports = model('Message', messageSchema);
