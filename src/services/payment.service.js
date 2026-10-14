// Payments (Phase 31): premium plans and credit packs through Cashfree.
//
//  createOrder(user, { planId, phone }) -> Payment 'created' + Cashfree order -> payment_session_id
//  verifyOrder(orderId)  -> asks Cashfree (never trusts the app) and grants once when PAID
//  handleWebhook(raw, h) -> signature check, then the same verifyOrder()
//
// Granting is idempotent (31.13): credit packs use the wallet refId `payment:<orderId>`; premium
// extends premiumUntil and marks the Payment granted inside ONE MongoDB transaction, so the
// webhook and the app's verify can both arrive without granting twice.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const config = require('../config');
const { planById } = require('../constants/plans');
const cashfree = require('./cashfree.service');
const wallet = require('./wallet.service');
const emitter = require('../sockets/emitter');
const EVENTS = require('../constants/socketEvents.json');

const DAY_MS = 24 * 3600 * 1000;
const PHONE = /^[6-9]\d{9}$/; // Indian mobile, required by Cashfree

const newOrderId = () => `TL_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

const toPayment = (p) => ({
  orderId: p.orderId,
  plan: p.plan,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  grantedAt: p.grantedAt || null,
  createdAt: p.createdAt,
});

// 31.5 / 31.6
const createOrder = async (user, { planId, phone }) => {
  const plan = planById(planId);
  if (!plan) throw ApiError.badRequest('Unknown plan', 'UNKNOWN_PLAN');
  const customerPhone = phone || user.billingPhone;
  if (!customerPhone || !PHONE.test(customerPhone)) {
    throw ApiError.badRequest('Enter your 10-digit mobile number to pay', 'PHONE_REQUIRED');
  }
  if (phone && phone !== user.billingPhone) {
    await User.updateOne({ _id: user._id }, { $set: { billingPhone: phone } });
  }
  const orderId = newOrderId();
  const payment = await Payment.create({
    userId: user._id,
    orderId,
    amount: plan.price,
    plan: plan.id,
    status: 'created',
  });
  const meta = {};
  if (config.cashfree.returnUrl)
    meta.return_url = config.cashfree.returnUrl.replace('{order_id}', orderId);
  if (config.cashfree.notifyUrl) meta.notify_url = config.cashfree.notifyUrl;
  let order;
  try {
    order = await cashfree.createOrder({
      order_id: orderId,
      order_amount: plan.price,
      order_currency: 'INR',
      customer_details: {
        customer_id: String(user._id),
        customer_email: user.email,
        customer_phone: customerPhone,
        customer_name: user.name || undefined,
      },
      order_meta: meta,
      order_note: `TalkLink ${plan.label}`,
      order_tags: { plan: plan.id },
    });
  } catch (err) {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    throw err;
  }
  await Payment.updateOne(
    { _id: payment._id },
    { $set: { cfOrderId: String(order.cf_order_id || '') } },
  );
  logger.info({ orderId, plan: plan.id, amount: plan.price }, 'Payment order created');
  return {
    orderId,
    paymentSessionId: order.payment_session_id,
    environment: cashfree.settings.env === 'production' ? 'PRODUCTION' : 'SANDBOX',
    amount: plan.price,
    plan: plan.id,
  };
};

const grantPremium = async (payment, plan) => {
  const session = await mongoose.startSession();
  let premiumUntil = null;
  let granted = false;
  try {
    await session.withTransaction(async () => {
      const claim = await Payment.updateOne(
        { _id: payment._id, grantedAt: { $exists: false } },
        { $set: { grantedAt: new Date(), status: 'paid' } },
        { session },
      );
      if (!claim.modifiedCount) return; // already granted (webhook + verify race)
      const user = await User.findById(payment.userId).session(session);
      const from =
        user.premiumUntil && user.premiumUntil > new Date()
          ? user.premiumUntil.getTime()
          : Date.now();
      premiumUntil = new Date(from + plan.days * DAY_MS);
      user.isPremium = true;
      user.premiumUntil = premiumUntil;
      await user.save({ session });
      granted = true;
    });
  } finally {
    await session.endSession();
  }
  if (granted) {
    emitter.emitToUser(String(payment.userId), EVENTS.PREMIUM_UPDATED, {
      isPremium: true,
      premiumUntil,
    });
    logger.info({ orderId: payment.orderId, premiumUntil }, 'Premium granted');
  }
  return { granted, premiumUntil };
};

const grantCredits = async (payment, plan) => {
  const res = await wallet.credit({
    userId: payment.userId,
    amount: plan.credits,
    type: 'purchase',
    refId: `payment:${payment.orderId}`,
    meta: { plan: plan.id, amount: payment.amount },
  });
  await Payment.updateOne(
    { _id: payment._id, grantedAt: { $exists: false } },
    { $set: { grantedAt: new Date(), status: 'paid' } },
  );
  if (res.applied)
    logger.info({ orderId: payment.orderId, credits: plan.credits }, 'Credits granted');
  return { granted: res.applied, balance: res.balance };
};

const grant = (payment) => {
  const plan = planById(payment.plan);
  if (!plan) throw new Error(`plan ${payment.plan} no longer exists`);
  return plan.kind === 'premium' ? grantPremium(payment, plan) : grantCredits(payment, plan);
};

// payment attempts -> our status while the order is still ACTIVE
const attemptStatus = (payments) => {
  const list = Array.isArray(payments) ? payments : [];
  if (!list.length) return 'pending';
  const latest = [...list].sort(
    (a, b) => new Date(b.payment_time || 0) - new Date(a.payment_time || 0),
  )[0];
  switch (latest.payment_status) {
    case 'SUCCESS':
      return 'paid';
    case 'FAILED':
      return 'failed';
    case 'USER_DROPPED':
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'pending';
  }
};

// 31.9 / 31.10 - userId given = the app asks (must own it); null = webhook
const verifyOrder = async (orderId, userId = null) => {
  const payment = await Payment.findOne({ orderId });
  if (!payment || (userId && String(payment.userId) !== String(userId))) {
    throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  }
  const user = () => User.findById(payment.userId).select('credits isPremium premiumUntil').lean();
  if (payment.grantedAt) {
    const u = await user();
    return {
      orderId,
      plan: payment.plan,
      status: 'paid',
      granted: true,
      alreadyGranted: true,
      premiumUntil: u.premiumUntil || null,
      balance: u.credits,
    };
  }
  const order = await cashfree.getOrder(orderId);
  let status;
  switch (order.order_status) {
    case 'PAID':
      status = 'paid';
      break;
    case 'EXPIRED':
    case 'TERMINATED':
    case 'TERMINATION_REQUESTED':
      status = 'cancelled';
      break;
    default:
      status = attemptStatus(await cashfree.getPayments(orderId).catch(() => []));
  }
  // a successful attempt is only trusted when the order itself says PAID
  if (status === 'paid' && order.order_status !== 'PAID') status = 'pending';

  if (status === 'paid') {
    await grant(payment);
    const u = await user();
    return {
      orderId,
      plan: payment.plan,
      status,
      granted: true,
      premiumUntil: u.premiumUntil || null,
      balance: u.credits,
    };
  }
  await Payment.updateOne(
    { _id: payment._id, grantedAt: { $exists: false } },
    { $set: { status: status === 'pending' ? 'pending' : status } },
  );
  return { orderId, plan: payment.plan, status, granted: false };
};

// 31.11 - 31.13
const handleWebhook = async (rawBody, headers) => {
  const ok = cashfree.verifyWebhookSignature(
    rawBody,
    headers['x-webhook-timestamp'],
    headers['x-webhook-signature'],
  );
  if (!ok) throw ApiError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw ApiError.badRequest('Invalid JSON', 'VALIDATION_ERROR');
  }
  const orderId = body && body.data && body.data.order && body.data.order.order_id;
  if (!orderId) return { received: true, ignored: 'NO_ORDER' };
  const exists = await Payment.findOneAndUpdate(
    { orderId },
    {
      $set: { rawWebhook: { type: body.type, at: new Date(), payment: body.data.payment || null } },
    },
  );
  if (!exists) return { received: true, ignored: 'UNKNOWN_ORDER' };
  const result = await verifyOrder(orderId); // ask Cashfree for the truth
  return { received: true, status: result.status };
};

// 31.17
const listPayments = async (userId) => {
  const rows = await Payment.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
  return { items: rows.map(toPayment) };
};

// 31.18 daily job
const expirePremium = async () => {
  const res = await User.updateMany(
    { isPremium: true, premiumUntil: { $lt: new Date() } },
    { $set: { isPremium: false } },
  );
  return res.modifiedCount ? { expired: res.modifiedCount } : null;
};

module.exports = {
  createOrder,
  verifyOrder,
  handleWebhook,
  listPayments,
  expirePremium,
  attemptStatus,
};
