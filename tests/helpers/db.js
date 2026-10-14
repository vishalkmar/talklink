// Integration-test helpers: real Mongo (talklink_test, replica set; default local 27017, or
// TEST_MONGO_URI) + the in-memory store, cleared between tests.
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../../src/config/db');
const { store, connectStore, disconnectStore } = require('../../src/config/store');
const models = require('../../src/models');

const DEPS_TIMEOUT_MS = 20000; // generous: index builds right after another file dropped the DB can be slow

// Safety: these helpers wipe the database and the store. Refuse anything that is not the test setup
// (e.g. running `node --test` without `--require ./tests/setupEnv.js` would hit the dev DB).
const assertTestTarget = () => {
  const uri = process.env.MONGO_URI || '';
  const dbName = (uri.split('/')[3] || '').split('?')[0];
  if (process.env.NODE_ENV !== 'test' || !dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}". Use npm test (loads tests/setupEnv.js).`,
    );
  }
};

const connectTestDeps = async () => {
  assertTestTarget();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'Test MongoDB unreachable - start a local MongoDB (replica set) or set TEST_MONGO_URI',
          ),
        ),
      DEPS_TIMEOUT_MS,
    );
  });
  await Promise.race([Promise.all([connectDB(), connectStore()]), timeout]).finally(() =>
    clearTimeout(timer),
  );
  await Promise.all(Object.values(models).map((m) => m.init())); // build indexes
};

const resetTestDeps = async () => {
  assertTestTarget();
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  await store.flushdb();
};

const closeTestDeps = async () => {
  assertTestTarget();
  await mongoose.connection.dropDatabase();
  await Promise.all([disconnectDB(), disconnectStore()]);
};

module.exports = { connectTestDeps, resetTestDeps, closeTestDeps };
