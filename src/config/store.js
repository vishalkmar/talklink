// The app's short-lived state store (presence, locks, counters, caches) - in memory, no Store
// (ADR-041). Import: const { store } = require('../config/store');
const logger = require('../utils/logger');
const { registerCheck } = require('../services/health.service');
const { MemoryStore } = require('./memoryStore');

const store = new MemoryStore();

const connectStore = async () => {
  await store.connect();
  logger.info('In-memory store ready');
};

const disconnectStore = async () => {
  await store.quit();
};

registerCheck('store', () => (store.status === 'ready' ? 'up' : 'down'));

module.exports = { store, connectStore, disconnectStore };
