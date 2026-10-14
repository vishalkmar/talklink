const { Schema, model } = require('mongoose');

// One document per refresh token (rotated on every refresh). Only the token hash is stored.
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true }, // shared by all rotations of one login
    device: {
      platform: String,
      model: String,
      appVersion: String,
    },
    ip: String,
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    replacedBy: { type: String }, // tokenHash of the next token (reuse detection)
  },
  { timestamps: true },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('Session', sessionSchema);
