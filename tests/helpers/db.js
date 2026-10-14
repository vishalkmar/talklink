// Integration-test helpers: real Mongo (talklink_test, replica set) + Redis (db 15). Defaults to a
// local MongoDB on 27017 + Redis on 6380; point TEST_MONGO_URI / TEST_REDIS_URL elsewhere if needed.
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../../src/config/db');
const { redis, connectRedis, disconnectRedis } = require('../../src/config/redis');
const models = require('../../src/models');

const DEPS_TIMEOUT_MS = 20000; // generous: index builds right after another file dropped the DB can be slow

// Safety: these helpers wipe the database and Redis. Refuse anything that is not the test setup
// (e.g. running `node --test` without `--require ./tests/setupEnv.js` would hit the dev DB).
const assertTestTarget = () => {
  const uri = process.env.MONGO_URI || '';
  const dbName = (uri.split('/')[3] || '').split('?')[0];
  const redisDb = (process.env.REDIS_URL || '').split('/')[3];
  const redisOk = process.env.REDIS_URL === '' || redisDb === '15'; // '' = in-memory store
  if (process.env.NODE_ENV !== 'test' || !dbName.endsWith('_test') || !redisOk) {
    throw new Error(
      `Refusing to run tests against "${dbName}" / redis db "${redisDb}". Use npm test (loads tests/setupEnv.js).`,
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
            'Test Mongo/Redis unreachable - start a local MongoDB (replica set) + Redis, or set TEST_MONGO_URI / TEST_REDIS_URL',
          ),
        ),
      DEPS_TIMEOUT_MS,
    );
  });
  await Promise.race([Promise.all([connectDB(), connectRedis()]), timeout]).finally(() =>
    clearTimeout(timer),
  );
  await Promise.all(Object.values(models).map((m) => m.init())); // build indexes
};

const resetTestDeps = async () => {
  assertTestTarget();
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  await redis.flushdb();
};

const closeTestDeps = async () => {
  assertTestTarget();
  await mongoose.connection.dropDatabase();
  await Promise.all([disconnectDB(), disconnectRedis()]);
};

module.exports = { connectTestDeps, resetTestDeps, closeTestDeps };
