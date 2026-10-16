const { Schema, model } = require('mongoose');

const schema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    state: { type: String, enum: ['pending', 'active', 'deleting'], default: 'pending' },
    slot: { type: Number, min: 0, max: 2 },
    publicId: { type: String, required: true, unique: true },
    resourceType: { type: String, enum: ['image', 'video'], required: true },
    url: String,
    durationSec: Number,
    caption: { type: String, maxlength: 300, default: '' },
    viewers: [{ _id: false, user: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date }],
    publishedAt: Date,
    expiresAt: { type: Date, required: true },
    uploadExpiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Three slots enforce the limit even across simultaneous requests / server instances.
schema.index({ owner: 1, slot: 1 }, { unique: true, partialFilterExpression: { state: 'active' } });
schema.index({ state: 1, expiresAt: 1 });
// Intentionally no TTL: keep the deletion receipt until Cloudinary confirms removal.
module.exports = model('Status', schema);
