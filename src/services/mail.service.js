// Transactional email via Brevo's REST API (POST /v3/smtp/email).
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { otpEmail } = require('../templates/otpEmail');

const brevo = axios.create({
  baseURL: 'https://api.brevo.com/v3',
  timeout: 10000,
  headers: { 'content-type': 'application/json', accept: 'application/json' },
});

// tests swap the keys; production reads them from .env once
const settings = { ...config.brevo };

const isConfigured = () => Boolean(settings.apiKey && settings.senderEmail);

const sendEmail = async ({ to, subject, html, text, tags = [], replyTo }) => {
  if (!isConfigured()) {
    // Dev without Brevo keys: nothing is sent; use DEV_OTP_BYPASS (000000) to log in.
    logger.warn({ tags }, 'Brevo not configured - email not sent');
    return { skipped: true };
  }
  try {
    const { data } = await brevo.post(
      '/smtp/email',
      {
        sender: { email: settings.senderEmail, name: settings.senderName },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        tags,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      },
      { headers: { 'api-key': settings.apiKey } },
    );
    return { messageId: data && data.messageId };
  } catch (err) {
    logger.error(
      {
        provider: 'brevo',
        status: err.response && err.response.status,
        providerCode: err.response && err.response.data && err.response.data.code,
        providerMessage: err.response && err.response.data && err.response.data.message,
        err: err.code || err.message,
      },
      'Brevo send failed',
    );
    throw new ApiError(
      502,
      'EMAIL_SEND_FAILED',
      'Could not send the email right now. Try again shortly.',
    );
  }
};

const sendOtpEmail = (email, otp, purpose = 'login') => {
  const { subject, html, text } = otpEmail({
    appName: config.appName,
    otp,
    ttlMinutes: Math.round(config.otp.ttlSeconds / 60),
    purpose,
  });
  return sendEmail({ to: email, subject, html, text, tags: ['otp', purpose] });
};

module.exports = { settings, sendEmail, sendOtpEmail, isConfigured, __client: brevo };
