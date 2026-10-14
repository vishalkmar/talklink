// Redis: one client for commands, a duplicate for pub/sub (a subscribed connection
// can't run normal commands). The Socket.IO adapter reuses both in Phase 13.
// REDIS_URL empty -> an in-memory store with the same API (config/memoryRedis.js): no Redis
// service needed, but only ONE server instance (state lives in this process).
const Redis = require('ioredis');
const { MemoryRedis } = require('./memoryRedis');
const config = require('./index');
const logger = require('../utils/logger');
const { registerCheck } = require('../services/health.service');

const options = {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 5000),
};

const redis = config.redis.inMemory
  ? new MemoryRedis()
  : new Redis(config.redis.url, { ...options, connectionName: 'talklink-cmd' });
const redisSub = redis.duplicate({ connectionName: 'talklink-sub' });

for (const [name, client] of [
  ['cmd', redis],
  ['sub', redisSub],
]) {
  client.on('error', (err) => logger.error({ err: err.message, client: name }, 'Redis error'));
  client.on('reconnecting', () => logger.warn({ client: name }, 'Redis reconnecting'));
}

const connectRedis = async () => {
  await Promise.all([redis.connect(), redisSub.connect()]);
  logger.info(config.redis.inMemory ? 'Using in-memory store (no REDIS_URL)' : 'Redis connected');
};

const disconnectRedis = async () => {
  await Promise.allSettled([redis.quit(), redisSub.quit()]);
};

const redisStatus = () =>
  redis.status === 'ready' ? 'up' : redis.status === 'end' ? 'down' : redis.status;

registerCheck('redis', redisStatus);

module.exports = { redis, redisSub, connectRedis, disconnectRedis, redisStatus };
