// Phase 11: signup bonus, name filter, private-number uniqueness across accounts.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { User, CreditTransaction } = require('../src/models');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const walletService = require('../src/services/wallet.service');
const { findOrCreateUser } = require('../src/services/auth.service');
const { checkName } = require('../src/utils/nameFilter');

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

describe('signup bonus (11.11)', () => {
  it('credits new users once, with a matching ledger entry', async () => {
    const { user, created } = await findOrCreateUser('new@t.io');
    assert.equal(created, true);
    assert.equal(user.credits, 100);

    const fresh = await User.findById(user._id);
    assert.equal(fresh.credits, 100);
    const ledger = await CreditTransaction.find({ userId: user._id }).lean();
    assert.equal(ledger.length, 1);
    assert.deepEqual(
      { amount: ledger[0].amount, type: ledger[0].type, balanceAfter: ledger[0].balanceAfter },
      { amount: 100, type: 'signup_bonus', balanceAfter: 100 },
    );

    // logging in again does not pay again
    const again = await findOrCreateUser('new@t.io');
    assert.equal(again.created, false);
    assert.equal((await User.findById(user._id)).credits, 100);
  });

  it('credit() is idempotent by refId, even when called concurrently', async () => {
    const u = await createUniqueUser({ email: 'w@t.io' });
    const args = { userId: u._id, amount: 50, type: 'admin', refId: 'support-ticket-1' };
    const results = await Promise.all([walletService.credit(args), walletService.credit(args)]);
    assert.equal(results.filter((r) => r.applied).length, 1);
    assert.equal((await User.findById(u._id)).credits, 50);
    assert.equal(await CreditTransaction.countDocuments({ refId: 'support-ticket-1' }), 1);
  });

  it('rejects non-positive or fractional amounts', async () => {
    const u = await createUniqueUser({ email: 'w2@t.io' });
    for (const amount of [0, -5, 1.5]) {
      await assert.rejects(
        walletService.credit({ userId: u._id, amount, type: 'admin', refId: `x${amount}` }),
        { code: 'INVALID_AMOUNT' },
      );
    }
  });
});

describe('name filter (11.13)', () => {
  it('allows real names that contain look-alike fragments', () => {
    for (const n of ['Riya', 'Ashita', 'Rathod', 'Chodankar', 'Dickens', 'Cassandra', 'Stafford']) {
      assert.equal(checkName(n), null, n);
    }
  });

  it('blocks abuse (incl. spacing / leetspeak) and impersonation', () => {
    for (const n of ['fuck', 'f u c k', 'ch0d', 'MadarChod', 'Big Shit', 'bhosdi wala']) {
      assert.equal(checkName(n), 'PROFANITY', n);
    }
    for (const n of ['Admin', 'TalkLink Support', 'talk link', 'Official']) {
      assert.equal(checkName(n), 'RESERVED', n);
    }
  });

  it('PATCH /users/me rejects a blocked name with NAME_NOT_ALLOWED', async () => {
    const u = await createUniqueUser({ email: 'n@t.io' });
    const token = signAccessToken(u._id);
    const bad = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Chutiya' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'NAME_NOT_ALLOWED');

    const ok = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ashita', gender: 'female', avatar: 'avatar_02' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.user.isProfileComplete, true);
    assert.match(ok.body.data.user.privateNumber, /^\d{5,6}$/);
  });
});

describe('unicode names', () => {
  it('accepts Hindi and accented names (matras are combining marks)', async () => {
    const u = await createUniqueUser({ email: 'hi@t.io' });
    const token = signAccessToken(u._id);
    for (const name of ['राहुल', 'प्रिया शर्मा', 'José K']) {
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ name });
      assert.equal(res.status, 200, name);
      assert.equal(res.body.data.user.name, name);
    }
  });
});

describe('private numbers (11.18)', () => {
  it('3 accounts created through login all get different numbers', async () => {
    const users = await Promise.all(
      ['a@t.io', 'b@t.io', 'c@t.io'].map((e) => findOrCreateUser(e).then((r) => r.user)),
    );
    const numbers = users.map((u) => u.privateNumber);
    assert.equal(new Set(numbers).size, 3);
    numbers.forEach((n) => assert.match(n, /^\d{5}$/));
  });
});
