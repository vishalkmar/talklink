// Wraps an async controller so rejected promises reach the error handler.
// (Express 5 does this natively; the wrapper keeps controllers explicit and portable.)
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
