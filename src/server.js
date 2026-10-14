// HTTP + Socket.IO server entry point.
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const { initMonitoring, captureError, flushMonitoring } = require('./utils/monitoring');

initMonitoring(); // 34.4 Sentry, before anything else can fail
const app = require('./app');
const { connectDB, disconnectDB } = require('./config/db');
const { connectRedis, disconnectRedis } = require('./config/redis');
const { initSockets, closeSockets } = require('./sockets');
const { startJobs, stopJobs } = require('./jobs');
const { initPush } = require('./services/push.service');

const server = http.createServer(app);

// Resources to close on shutdown, in order (after the HTTP server stops accepting).
const closers = [stopJobs, disconnectDB, disconnectRedis];

const start = async () => {
  await Promise.all([connectDB(), connectRedis()]);
  initPush(); // FCM (skipped when FIREBASE_SERVICE_ACCOUNT is empty)
  initSockets(server);
  startJobs();
  server.listen(config.port, () => {
    logger.info(`${config.appName} API listening on :${config.port} (${config.env})`);
  });
};

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');

  const force = setTimeout(() => {
    logger.error('Forced shutdown after 10s');
    process.exit(1);
  }, 10000);
  force.unref();

  try {
    // io.close() disconnects every socket and closes the HTTP server it is attached to.
    await closeSockets();
    for (const close of closers) await close();
    await flushMonitoring();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
  captureError(err, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  captureError(err, { kind: 'uncaughtException' });
  shutdown('uncaughtException');
});

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

module.exports = server;
