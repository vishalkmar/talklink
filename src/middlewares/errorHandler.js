// Central error handler: every error leaves the API as { success:false, code, message }.
const ApiError = require('../utils/ApiError');
const config = require('../config');
const { captureError } = require('../utils/monitoring');

const notFound = (req, res, next) =>
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND'));

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    if (err.type === 'entity.too.large') {
      error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else if (err.type === 'entity.parse.failed') {
      error = ApiError.badRequest('Malformed JSON body', 'INVALID_JSON');
    } else if (err.isJoi) {
      error = ApiError.badRequest(err.details[0].message, 'VALIDATION_ERROR');
    } else {
      error = ApiError.internal();
    }
  }

  const log = req.log || console;
  if (error.status >= 500) {
    log.error({ err }, 'Unhandled error');
    captureError(err, {
      userId: req.user && req.user._id,
      requestId: req.id,
      route: `${req.method} ${req.baseUrl || ''}${(req.route && req.route.path) || ''}`,
    });
  } else {
    log.warn({ code: error.code, status: error.status }, error.message);
  }

  const body = { success: false, code: error.code, message: error.message };
  if (error.details) body.details = error.details;
  if (!config.isProd && error.status >= 500 && err.message) body.debug = err.message;

  res.status(error.status).json(body);
};

module.exports = { notFound, errorHandler };
