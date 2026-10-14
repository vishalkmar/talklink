// Phase 34.4: Sentry is off without a DSN, and events never carry personal data.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { initMonitoring, captureError, scrub } = require('../src/utils/monitoring');

describe('monitoring', () => {
  it('stays off in tests / without SENTRY_DSN', () => {
    assert.equal(initMonitoring(), false);
    assert.equal(captureError(new Error('x'), { userId: 'u1' }), null);
  });

  it('scrubs bodies, secrets and personal fields', () => {
    const event = scrub({
      request: {
        data: '{"otp":"123456"}',
        cookies: { a: 1 },
        query_string: 'email=a@b.io',
        headers: {
          authorization: 'Bearer x',
          'x-admin-key': 'k',
          'user-agent': 'okhttp',
          'x-app-version': '1.0.0',
        },
      },
      user: { id: 'u1', email: 'a@b.io', ip_address: '1.2.3.4' },
    });
    assert.equal(event.request.data, undefined);
    assert.equal(event.request.cookies, undefined);
    assert.equal(event.request.query_string, '[removed]');
    assert.deepEqual(Object.keys(event.request.headers).sort(), ['user-agent', 'x-app-version']);
    assert.deepEqual(event.user, { id: 'u1' });
  });
});
