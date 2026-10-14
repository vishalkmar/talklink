const { Schema, model } = require('mongoose');

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User' }, // null for system messages
    text: { type: String, required: true, maxlength: 1000 },
    type: { type: String, enum: ['text', 'system'], default: 'text' },
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
messageSchema.index(
  { senderId: 1, clientMsgId: 1 },
  { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } },
);

module.exports = model('Message', messageSchema);
