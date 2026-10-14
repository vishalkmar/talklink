// joi validation for body / params / query. Validated values land on req.valid
// (and req.body is replaced with the cleaned body).
const ApiError = require('../utils/ApiError');

const validate = (schemas) => (req, res, next) => {
  req.valid = req.valid || {};
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const { value, error } = schemas[part].validate(req[part] || {}, {
      abortEarly: true,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      return next(
        ApiError.badRequest(error.details[0].message.replace(/"/g, ''), 'VALIDATION_ERROR'),
      );
    }
    req.valid[part] = value;
    if (part === 'body') req.body = value;
  }
  return next();
};

module.exports = validate;
