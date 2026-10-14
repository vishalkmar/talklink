// Phase 33: notification + DND settings, muted pushes, invite codes, Contact Us, FAQ,
// delete account with an emailed code.
const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { CreditTransaction, Feedback, User } = require('../src/models');
const mailService = require('../src/services/mail.service');
const push = require('../src/services/push.service');
const referrals = require('../src/services/referral.service');
const feedback = require('../src/services/feedback.service');

const make = async (email, name = 'Tester') => {
  const u = await createUniqueUser({ email, name, gender: 'female' });
  return { user: u, uid: String(u._id), token: signAccessToken(u._id) };
};
const as = (who) => (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${who.token}`);

let me;
let api;
let mails;
let sent;

before(connectTestDeps);
beforeEach(async () => {
  me = await make('me@t.io', 'Riya');
  api = as(me);
  mails = [];
  mock.method(mailService, 'sendOtpEmail', async (email, otp, purpose) => {
    mails.push({ email, otp, purpose });
    return { messageId: 'x' };
  });
  sent = [];
  push.__setTransportForTests(async (msg) => {
    sent.push(msg.data.type);
    return 'id';
  });
});
afterEach(async () => {
  mock.restoreAll();
  push.__setTransportForTests(null);
  await resetTestDeps();
});
after(closeTestDeps);

describe('settings (33.7)', () => {
  it('defaults, partial updates and validation', async () => {
    const before_ = (await api('get', '/users/me')).body.data.user.settings;
    assert.deepEqual(before_.notifications, {
      calls: true,
      messages: true,
      streakReminders: true,
      promotions: false,
    });
    assert.deepEqual(before_.dnd, { enabled: false, start: '22:00', end: '07:00' });

    const res = await api('patch', '/users/me/settings').send({
      notifications: { messages: false },
      dnd: { enabled: true, start: '23:30' },
    });
    assert.equal(res.status, 200);
    const s = res.body.data.user.settings;
    assert.equal(s.notifications.messages, false);
    assert.equal(s.notifications.calls, true); // untouched
    assert.deepEqual(s.dnd, { enabled: true, start: '23:30', end: '07:00' });

    assert.equal(
      (await api('patch', '/users/me/settings').send({ dnd: { start: '25:00' } })).status,
      400,
    );
    const same = await api('patch', '/users/me/settings').send({ dnd: { start: '07:00' } });
    assert.equal(same.body.code, 'DND_INVALID');
  });

  it('a switched-off push type is not sent; cancels still go out', async () => {
    await User.updateOne({ _id: me.uid }, { fcmToken: 'tok'.padEnd(30, 'x') });
    await api('patch', '/users/me/settings').send({
      notifications: { messages: false, calls: false },
    });
    assert.deepEqual(await push.sendToUser(me.uid, push.PUSH.NEW_MESSAGE, {}), {
      sent: false,
      reason: 'muted',
    });
    assert.equal((await push.sendToUser(me.uid, push.PUSH.INCOMING_CALL, {})).reason, 'muted');
    assert.equal((await push.sendToUser(me.uid, push.PUSH.CALL_CANCELLED, {})).sent, true);
    assert.equal((await push.sendToUser(me.uid, push.PUSH.STREAK_REMINDER, {})).sent, true);
    assert.deepEqual(sent, ['call_cancelled', 'streak_reminder']);
  });
});

describe('18+ confirmation (34.17)', () => {
  it('saved once at signup, can never be taken back', async () => {
    assert.equal((await api('get', '/users/me')).body.data.user.ageConfirmed, false);
    const res = await api('patch', '/users/me').send({ ageConfirmed: true });
    assert.equal(res.body.data.user.ageConfirmed, true);
    const first = (await User.findById(me.uid).lean()).ageConfirmedAt;
    await api('patch', '/users/me').send({ ageConfirmed: true });
    assert.deepEqual((await User.findById(me.uid).lean()).ageConfirmedAt, first);
    assert.equal((await api('patch', '/users/me').send({ ageConfirmed: false })).status, 400);
  });
});

describe('invite friends (33.8)', () => {
  it('code + link; a new user enters it once and both get the bonus', async () => {
    const mine = (await api('get', '/referrals/me')).body.data;
    assert.match(mine.code, referrals.CODE_RE);
    assert.ok(mine.link.includes(mine.code));
    assert.equal(mine.invited, 0);
    // same code next time
    assert.equal((await api('get', '/referrals/me')).body.data.code, mine.code);

    const friend = await make('friend@t.io', 'Aman');
    const res = await as(friend)('post', '/referrals/apply').send({
      code: mine.code.toLowerCase(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      {
        applied: res.body.data.applied,
        bonus: res.body.data.bonus,
        inviter: res.body.data.inviterRewarded,
      },
      { applied: true, bonus: 200, inviter: true },
    );
    assert.equal((await User.findById(friend.uid).lean()).credits, 200);
    assert.equal((await User.findById(me.uid).lean()).credits, 200);
    const again = await as(friend)('post', '/referrals/apply').send({ code: mine.code });
    assert.equal(again.body.code, 'ALREADY_REFERRED');
    const after_ = (await api('get', '/referrals/me')).body.data;
    assert.deepEqual([after_.invited, after_.earned], [1, 200]);
    assert.equal((await as(friend)('get', '/users/me')).body.data.user.referred, true);
  });

  it('own code, loops, bad codes, old accounts and the daily limit', async () => {
    const { code } = (await api('get', '/referrals/me')).body.data;
    assert.equal((await api('post', '/referrals/apply').send({ code })).body.code, 'OWN_CODE');
    assert.equal(
      (await api('post', '/referrals/apply').send({ code: 'ZZZZZZ' })).body.code,
      'INVALID_CODE',
    );
    assert.equal(
      (await api('post', '/referrals/apply').send({ code: '0O0' })).body.code,
      'INVALID_CODE',
    );

    // B used A's code -> A can't use B's code
    const b = await make('b@t.io', 'Bina');
    await as(b)('post', '/referrals/apply').send({ code });
    const bCode = (await as(b)('get', '/referrals/me')).body.data.code;
    assert.equal(
      (await api('post', '/referrals/apply').send({ code: bCode })).body.code,
      'REFERRAL_LOOP',
    );

    const old = await make('old@t.io', 'Olga');
    // createdAt is immutable in mongoose: age the account directly in the collection
    await User.collection.updateOne(
      { _id: old.user._id },
      { $set: { createdAt: new Date(Date.now() - 8 * 86400000) } },
    );
    assert.equal(
      (await as(old)('post', '/referrals/apply').send({ code })).body.code,
      'REFERRAL_WINDOW_OVER',
    );

    referrals.settings.maxPerDay = 1; // b already used it today
    const c = await make('c@t.io', 'Chet');
    const res = await as(c)('post', '/referrals/apply').send({ code });
    referrals.settings.maxPerDay = 20;
    assert.equal(res.body.data.inviterRewarded, false);
    assert.equal((await User.findById(c.uid).lean()).credits, 200); // the new user is still paid
    assert.equal(await CreditTransaction.countDocuments({ userId: me.uid, type: 'referral' }), 1);
  });

  it('two requests at once pay once', async () => {
    const { code } = (await api('get', '/referrals/me')).body.data;
    const f = await make('f@t.io', 'Fay');
    const results = await Promise.all([
      as(f)('post', '/referrals/apply').send({ code }),
      as(f)('post', '/referrals/apply').send({ code }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await User.findById(me.uid).lean()).credits, 200);
  });
});

describe('Contact Us (33.12) and FAQ (33.9)', () => {
  it('saves feedback, emails the team, limits spam', async () => {
    const emails = [];
    mock.method(mailService, 'isConfigured', () => true);
    mock.method(mailService, 'sendEmail', async (m) => {
      emails.push(m);
      return { messageId: 'm' };
    });
    feedback.settings.feedbackTo = 'team@t.io';
    const res = await api('post', '/feedback')
      .set('X-App-Version', '1.2.3')
      .set('X-Platform', 'android')
      .send({
        type: 'problem',
        message: 'Calls drop <b>after</b> 2 minutes',
        contact: '9876543210',
      });
    feedback.settings.feedbackTo = '';
    assert.equal(res.status, 201);
    const doc = await Feedback.findById(res.body.data.id).lean();
    assert.equal(doc.type, 'problem');
    assert.equal(doc.appVersion, '1.2.3');
    assert.ok(doc.emailedAt);
    assert.equal(emails[0].to, 'team@t.io');
    assert.equal(emails[0].replyTo, 'me@t.io');
    assert.ok(emails[0].html.includes('&lt;b&gt;after&lt;/b&gt;')); // escaped
    assert.ok(emails[0].text.includes('#'));

    assert.equal(
      (await api('post', '/feedback').send({ type: 'rant', message: 'hello there' })).status,
      400,
    );
    assert.equal(
      (await api('post', '/feedback').send({ type: 'idea', message: 'hi' })).status,
      400,
    );
    for (let i = 0; i < 4; i += 1) {
      await api('post', '/feedback').send({ type: 'idea', message: `idea number ${i}` });
    }
    const limited = await api('post', '/feedback').send({ type: 'idea', message: 'one more idea' });
    assert.equal(limited.body.code, 'FEEDBACK_LIMIT');
  });

  it('works without email configured (stored only)', async () => {
    const res = await api('post', '/feedback').send({ type: 'feedback', message: 'Nice app!' });
    assert.equal(res.status, 201);
    assert.equal((await Feedback.findById(res.body.data.id).lean()).emailedAt, undefined);
  });

  it('FAQ is public with the live numbers filled in', async () => {
    const res = await request(app).get('/api/v1/content/faq');
    assert.equal(res.status, 200);
    const credits = res.body.data.items.find((i) => i.id === 'credits');
    assert.ok(credits.a.includes('200 credits each'));
    assert.ok(res.body.data.items.every((i) => !/\{\w+\}/.test(i.q + i.a)));
  });
});

describe('delete account (33.17)', () => {
  it('needs the emailed delete code; a login code does not work', async () => {
    assert.equal((await api('delete', '/users/me')).status, 400); // no code
    const sentRes = await api('post', '/users/me/delete-otp');
    assert.equal(sentRes.status, 200);
    assert.equal(sentRes.body.data.email, 'm***@t.io');
    assert.deepEqual(
      mails.map((m) => m.purpose),
      ['delete'],
    );
    const { otp } = mails[0];

    // a login code for the same email is a different record
    await request(app).post('/api/v1/auth/send-otp').send({ email: 'me@t.io' });
    const loginOtp = mails[1].otp;
    if (loginOtp !== otp) {
      const wrong = await api('delete', '/users/me').send({ otp: loginOtp });
      assert.equal(wrong.body.code, 'OTP_INVALID');
    }
    const ok = await api('delete', '/users/me').send({ otp });
    assert.equal(ok.status, 200);
    const u = await User.findById(me.uid).lean();
    assert.equal(u.status, 'deleted');
    assert.equal(u.name, undefined);
    // the session is gone
    assert.equal((await api('get', '/users/me')).status, 401);
  });
});
