const { Schema, model } = require('mongoose');

const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 }); // "who blocked me" lookups

// Blocks created outside block.service (seeds, scripts, tests) must not leave a stale
// blocks:<uid> cache (Phase 26.10). Required lazily so models stay free of Redis at load time.
blockSchema.post('save', async (doc) => {
  const { redis } = require('../config/redis');
  await redis.del(`blocks:${doc.blockerId}`, `blocks:${doc.blockedId}`);
});

module.exports = model('Block', blockSchema);
