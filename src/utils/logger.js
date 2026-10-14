// Pino logger: pretty output in development, JSON lines in production.
const pino = require('pino');
const config = require('../config');
const { REDACT_PATHS, censor } = require('./mask');

const logger = pino({
  level: config.logLevel,
  base: { app: config.appName },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor },
  ...(config.env === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' },
    },
  }),
});

module.exports = logger;
