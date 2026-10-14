// Express app (no listen) so tests can import it with supertest.
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const pinoHttp = require('pino-http');

const config = require('./config');
require('./config/db'); // registers the mongo health check
require('./config/redis'); // registers the redis health check
const logger = require('./utils/logger');
const requestId = require('./middlewares/requestId');
const sanitize = require('./middlewares/sanitize');
const { requireSupportedAppVersion } = require('./middlewares/appVersion');
const { globalLimiter } = require('./middlewares/rateLimiters');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const healthRoutes = require('./routes/health.routes');
const apiRoutes = require('./routes');
const { getConfig } = require('./controllers/config.controller');

const app = express();

// behind a hosting proxy (Render): how many proxy hops to trust for the client IP (rate limits)
if (config.isProd) app.set('trust proxy', config.trustProxy);

app.disable('x-powered-by');
// 'simple' = node:querystring: no nested objects from ?a[b]=c, so no operator injection via query.
app.set('query parser', 'simple');
app.use(requestId);
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customLogLevel: (req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url.startsWith('/health') },
  }),
);

app.use(helmet());
app.use(
  cors({
    // Native mobile apps send no Origin header; browsers must be on the allow-list.
    origin: (origin, cb) => {
      if (!origin || !config.isProd || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  }),
);
app.use(compression());
// No endpoint needs large bodies; the Cashfree webhook gets its own raw parser (Phase 31).
// 31.12 Cashfree webhook signature is over the RAW body - keep it raw for that route only
app.use('/api/v1/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(sanitize);

app.use(
  '/static',
  express.static(path.join(__dirname, '..', 'static'), {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  }),
);
app.use('/health', healthRoutes);
// /config stays reachable for outdated apps - it is how they learn they must update.
app.get('/api/v1/config', globalLimiter, getConfig);
app.use('/api/v1', globalLimiter, requireSupportedAppVersion, apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
