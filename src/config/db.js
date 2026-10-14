// MongoDB connection with retry-on-fail. Mongoose buffers queries until connected.
const dns = require('dns');
const mongoose = require('mongoose');
const config = require('./index');
const logger = require('../utils/logger');
const { registerCheck } = require('../services/health.service');

const MAX_RETRIES = 10;
const STATES = ['down', 'up', 'connecting', 'disconnecting'];

mongoose.set('strictQuery', true);

mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

// Production: the app creates any missing index itself on start (unique email, idempotent refIds,
// TTLs...). createIndexes never drops or rebuilds existing ones, so it is safe on every boot.
const ensureIndexes = async () => {
  const models = Object.values(mongoose.models);
  await Promise.all(models.map((m) => m.createIndexes()));
  logger.info({ models: models.length }, 'MongoDB indexes ensured');
};

const connectDB = async (uri = config.mongo.uri) => {
  if (config.dnsServers.length) dns.setServers(config.dnsServers);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 20,
        autoIndex: !config.isProd, // dev/test: mongoose builds them; production: ensureIndexes() below
      });
      logger.info(
        { host: mongoose.connection.host, db: mongoose.connection.name },
        'MongoDB connected',
      );
      if (config.isProd) {
        require('../models'); // every schema registered before creating indexes
        await ensureIndexes();
      }
      return mongoose.connection;
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
      logger.warn({ attempt, delay, err: err.message }, 'MongoDB connect failed, retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

const disconnectDB = () => mongoose.disconnect();

const mongoStatus = () => STATES[mongoose.connection.readyState] || 'down';

registerCheck('mongo', mongoStatus);

module.exports = { connectDB, disconnectDB, mongoStatus };
