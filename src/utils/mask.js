// Masks personal data before it reaches the logs.

// "rahul.test@example.com" -> "ra***@example.com"
const maskEmail = (email) => {
  if (typeof email !== 'string' || !email.includes('@')) return '[REDACTED]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};

// Paths pino must never print in full (tokens, OTPs, emails, auth headers).
const REDACT_PATHS = [
  'req.headers.authorization',
  'otp',
  '*.otp',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'fcmToken',
  'billingPhone',
  '*.billingPhone',
  '*.fcmToken',
  'email',
  '*.email',
];

const censor = (value, path) => {
  const key = path[path.length - 1];
  return key === 'email' ? maskEmail(value) : '[REDACTED]';
};

module.exports = { maskEmail, REDACT_PATHS, censor };
