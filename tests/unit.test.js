// Pure unit tests (no DB).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');
const { Writable } = require('node:stream');
const { maskEmail, REDACT_PATHS, censor } = require('../src/utils/mask');
const { compareVersions } = require('../src/utils/semver');
const { toSeconds } = require('../src/utils/duration');

describe('log masking', () => {
  it('masks emails', () => {
    assert.equal(maskEmail('rahul.test@example.com'), 'ra***@example.com');
  });

  it('never prints tokens, OTPs or full emails', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk;
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor } }, sink);
    log.info({
      email: 'secret.person@example.com',
      body: { otp: '482913', refreshToken: 'rt-abc', email: 'x.y@z.io' },
      req: { headers: { authorization: 'Bearer abc.def.ghi' } },
    });
    for (const secret of ['secret.person', '482913', 'rt-abc', 'abc.def.ghi', 'x.y@']) {
      assert.ok(!out.includes(secret), `leaked ${secret}`);
    }
    assert.ok(out.includes('se***@example.com'));
  });
});

describe('utils', () => {
  it('compares versions', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
    assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  });

  it('parses durations', () => {
    assert.equal(toSeconds('15m'), 900);
    assert.equal(toSeconds('30d'), 2592000);
    assert.equal(toSeconds('3600'), 3600);
    assert.throws(() => toSeconds('soon'));
  });
});
