// Cashfree Payment Gateway (PG) REST client (Phase 31). Keys stay on the server (.env).
// Docs: https://docs.cashfree.com/reference/pg-new-apis-endpoint
//   POST /orders              create an order -> payment_session_id for the app SDK
//   GET  /orders/:id          order_status ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED
//   GET  /orders/:id/payments payment attempts (SUCCESS | FAILED | PENDING | USER_DROPPED | CANCELLED)
// Webhooks are signed: base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret)).
const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const BASE = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};
const TIMEOUT_MS = 15000;

const settings = {
  appId: config.cashfree.appId,
  secretKey: config.cashfree.secretKey,
  webhookSecret: config.cashfree.webhookSecret,
  env: config.cashfree.env,
  apiVersion: config.cashfree.apiVersion || '2023-08-01',
};

const isConfigured = () => Boolean(settings.appId && settings.secretKey);

// default transport = fetch; tests replace it
let transport = async (method, path, body) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE[settings.env] || BASE.sandbox}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-client-id': settings.appId,
        'x-client-secret': settings.secretKey,
        'x-api-version': settings.apiVersion,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
};

const call = async (method, path, body) => {
  if (!isConfigured()) {
    throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not set up yet');
  }
  let res;
  try {
    res = await transport(method, path, body);
  } catch (err) {
    logger.error({ err: err.message, path }, 'Cashfree request failed');
    throw new ApiError(
      502,
      'PAYMENT_PROVIDER_ERROR',
      'Payment service is not reachable. Try again.',
    );
  }
  if (res.status >= 400) {
    logger.warn({ status: res.status, path, code: res.data && res.data.code }, 'Cashfree error');
    throw new ApiError(
      502,
      'PAYMENT_PROVIDER_ERROR',
      (res.data && res.data.message) || 'Payment failed',
    );
  }
  return res.data;
};

const createOrder = (order) => call('POST', '/orders', order);
const getOrder = (orderId) => call('GET', `/orders/${encodeURIComponent(orderId)}`);
const getPayments = (orderId) => call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);

// 31.11 webhook signature
const verifyWebhookSignature = (rawBody, timestamp, signature) => {
  const secret = settings.webhookSecret || settings.secretKey;
  if (!secret || !rawBody || !timestamp || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}${rawBody}`)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const __setTransportForTests = (fn) => {
  transport = fn;
};

module.exports = {
  settings,
  isConfigured,
  createOrder,
  getOrder,
  getPayments,
  verifyWebhookSignature,
  __setTransportForTests,
};
