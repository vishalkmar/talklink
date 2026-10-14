// Generates a unique private number (e.g. "86369"). Tries 5 digits first; once that range
// gets crowded it falls back to 6 digits. The unique index on User.privateNumber is the final
// guard against races - callers retry on a duplicate-key error (see createUniqueUser).
const { randomInt } = require('crypto');
const User = require('../models/User');

const FIVE_DIGIT_TRIES = 8;
const SIX_DIGIT_TRIES = 12;

const randomNumber = (digits) => String(randomInt(10 ** (digits - 1), 10 ** digits));

const generatePrivateNumber = async () => {
  for (let i = 0; i < FIVE_DIGIT_TRIES + SIX_DIGIT_TRIES; i += 1) {
    const candidate = randomNumber(i < FIVE_DIGIT_TRIES ? 5 : 6);
    const taken = await User.exists({ privateNumber: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not generate a unique private number');
};

const isDuplicateKey = (err, field) =>
  err && err.code === 11000 && (!field || Object.keys(err.keyPattern || {}).includes(field));

// Creates a user with a fresh private number, retrying if another insert grabbed it first.
const createUniqueUser = async (fields, retries = 3) => {
  for (let attempt = 0; ; attempt += 1) {
    const privateNumber = await generatePrivateNumber();
    try {
      return await User.create({ ...fields, privateNumber });
    } catch (err) {
      if (!isDuplicateKey(err, 'privateNumber') || attempt >= retries) throw err;
    }
  }
};

module.exports = { generatePrivateNumber, createUniqueUser, isDuplicateKey };
