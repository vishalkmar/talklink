// Runs in its own process (node --test isolates files), so the flag can be flipped before
// config loads.
process.env.DEV_OTP_BYPASS = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { connectTestDeps, closeTestDeps } = require('./helpers/db');

describe('DEV_OTP_BYPASS', () => {
  before(connectTestDeps);
  after(closeTestDeps);

  it('accepts 000000 without sending an email when enabled outside production', async () => {
    assert.equal(config.otp.devBypass, true);
    const res = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({ email: 'dev@talklink.app', otp: '000000' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.isNewUser, true);
  });
});
