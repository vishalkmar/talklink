const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { User, Block, Conversation, CreditTransaction } = require('../src/models');
const { generatePrivateNumber, createUniqueUser } = require('../src/utils/privateNumber');

const DUP = { code: 11000 };

before(connectTestDeps);
afterEach(resetTestDeps);
after(closeTestDeps);

describe('privateNumber', () => {
  it('generates a 5-digit numeric string', async () => {
    assert.match(await generatePrivateNumber(), /^\d{5}$/);
  });

  it('gives every created user a unique number', async () => {
    const users = await Promise.all(
      Array.from({ length: 25 }, (_, i) => createUniqueUser({ email: `u${i}@t.io` })),
    );
    assert.equal(new Set(users.map((u) => u.privateNumber)).size, 25);
  });

  it('cannot be changed after creation', async () => {
    const u = await createUniqueUser({ email: 'immut@t.io' });
    const original = u.privateNumber;
    u.privateNumber = '11111';
    await u.save();
    assert.equal((await User.findById(u._id)).privateNumber, original);
  });
});

describe('unique indexes', () => {
  it('rejects duplicate emails (case-insensitive)', async () => {
    await createUniqueUser({ email: 'dup@t.io' });
    await assert.rejects(createUniqueUser({ email: 'DUP@t.io' }), DUP);
  });

  it('rejects a duplicate block pair', async () => {
    const a = await createUniqueUser({ email: 'a@t.io' });
    const b = await createUniqueUser({ email: 'b@t.io' });
    await Block.create({ blockerId: a._id, blockedId: b._id });
    await assert.rejects(Block.create({ blockerId: a._id, blockedId: b._id }), DUP);
  });

  it('allows one permanent conversation per pair but many random sessions', async () => {
    const a = await createUniqueUser({ email: 'c1@t.io' });
    const b = await createUniqueUser({ email: 'c2@t.io' });
    const base = {
      participants: [a._id, b._id],
      participantsKey: Conversation.keyFor(a._id, b._id),
    };
    await Conversation.create(base);
    await assert.rejects(Conversation.create(base), DUP);
    await Conversation.create({ ...base, isRandomSession: true });
    await Conversation.create({ ...base, isRandomSession: true });
    assert.equal(await Conversation.countDocuments(), 3);
  });

  it('makes credit transactions idempotent by refId', async () => {
    const u = await createUniqueUser({ email: 'w@t.io' });
    const tx = {
      userId: u._id,
      amount: 100,
      type: 'signup_bonus',
      refId: `signup:${u._id}`,
      balanceAfter: 100,
    };
    await CreditTransaction.create(tx);
    await assert.rejects(CreditTransaction.create(tx), DUP);
  });
});
