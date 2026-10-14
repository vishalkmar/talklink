// Phase 32: streak (IST days, 11:59 PM edges), best, reset job, saver, aura, goals, leaderboard.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Call, CreditTransaction, User } = require('../src/models');
const { redis } = require('../src/config/redis');
const g = require('../src/services/gamification.service');
const ads = require('../src/services/ads.service');
const callService = require('../src/services/call.service');
const { istDayKey } = require('../src/utils/istDay');

// IST = UTC + 5:30
const ist = (s) => new Date(new Date(`${s}+05:30`).getTime());
let clock;
const at = (s) => {
  clock = ist(s);
};

let me;
const api = (method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${me.token}`);
const user = () => User.findById(me.uid).lean();

before(async () => {
  await connectTestDeps();
  g.settings.now = () => clock;
});

beforeEach(async () => {
  at('2026-10-12T12:00:00');
  Object.assign(g.settings, { minSeconds: 60, weekBonus: 200, saverDays: 7, auraPerGoodRating: 2 });
  const u = await createUniqueUser({ email: 'g@t.io', name: 'Gamer', gender: 'female' });
  me = { user: u, uid: String(u._id), token: signAccessToken(u._id) };
});

afterEach(resetTestDeps);
after(async () => {
  g.settings.now = () => new Date();
  await closeTestDeps();
});

describe('streak (32.1, 32.2, 32.18)', () => {
  it('first conversation of the day counts once; short ones do not', async () => {
    await g.recordConversation(me.uid, 30);
    assert.equal((await user()).streak, 0);
    await g.recordConversation(me.uid, 90);
    await g.recordConversation(me.uid, 600);
    const u = await user();
    assert.deepEqual([u.streak, u.bestStreak, u.lastActiveDay], [1, 1, '2026-10-12']);
  });

  it('11:59 PM and 12:01 AM are two different days', async () => {
    at('2026-10-12T23:59:00');
    await g.recordConversation(me.uid, 120);
    at('2026-10-13T00:01:00');
    await g.recordConversation(me.uid, 120);
    assert.equal((await user()).streak, 2);
    // UTC midnight is not a day boundary in IST
    at('2026-10-14T05:20:00'); // 23:50 UTC of the 13th
    await g.recordConversation(me.uid, 120);
    assert.equal((await user()).streak, 3);
  });

  it('a missed day restarts at 1; best stays', async () => {
    at('2026-10-10T10:00:00');
    await g.recordConversation(me.uid, 120);
    at('2026-10-11T10:00:00');
    await g.recordConversation(me.uid, 120);
    at('2026-10-13T10:00:00');
    await g.recordConversation(me.uid, 120);
    const u = await user();
    assert.deepEqual([u.streak, u.bestStreak], [1, 2]);
  });

  it('every 7th day pays the week bonus and the 7-day badge', async () => {
    for (let d = 1; d <= 7; d += 1) {
      at(`2026-10-0${d}T10:00:00`);
      await g.recordConversation(me.uid, 120);
    }
    const u = await user();
    assert.equal(u.streak, 7);
    assert.deepEqual(u.badges, ['streak_7']);
    assert.equal(u.credits, 200);
    assert.ok(await CreditTransaction.exists({ refId: `streak7:${me.uid}:2026-10-07` }));
  });
});

describe('nightly reset (32.3) and streak-saver (32.13)', () => {
  it('00:05 IST resets people who missed yesterday, not those active yesterday', async () => {
    const other = await createUniqueUser({ email: 'o@t.io', name: 'Other', gender: 'male' });
    at('2026-10-10T10:00:00');
    await g.recordConversation([me.uid, String(other._id)], 120);
    at('2026-10-11T10:00:00');
    await g.recordConversation(String(other._id), 120);
    at('2026-10-12T00:05:00');
    assert.deepEqual(await g.resetMissedStreaks(), { reset: 1 });
    const u = await user();
    assert.deepEqual([u.streak, u.streakBeforeReset, u.streakResetDay], [0, 1, '2026-10-12']);
    assert.equal((await User.findById(other._id).lean()).streak, 2);
  });

  it('a video brings back the lost streak once per week', async () => {
    for (let d = 7; d <= 10; d += 1) {
      at(`2026-10-${String(d).padStart(2, '0')}T10:00:00`);
      await g.recordConversation(me.uid, 120);
    }
    at('2026-10-12T00:05:00');
    await g.resetMissedStreaks(); // missed the 11th
    at('2026-10-12T09:00:00');
    const st = (await api('get', '/goals')).body.data.streak;
    assert.deepEqual(st.saver, { available: true, lostStreak: 4, nextAt: null });

    const noVideo = await api('post', '/goals/streak-saver');
    assert.equal(noVideo.status, 402);
    ads.settings.ssvEnabled = false;
    const { nonce } = (await api('post', '/ads/nonce').send({ purpose: 'streak' })).body.data;
    await api('post', '/ads/claim').send({ nonce });
    ads.settings.ssvEnabled = true;
    const saved = await api('post', '/goals/streak-saver');
    assert.equal(saved.body.data.streak, 4);
    // today's call continues it
    await g.recordConversation(me.uid, 120);
    assert.equal((await user()).streak, 5);
    // not again within 7 days
    at('2026-10-14T00:05:00');
    await g.resetMissedStreaks(); // missed the 13th
    at('2026-10-14T09:00:00');
    assert.equal((await api('get', '/goals')).body.data.streak.saver.available, false);
  });
});

describe('aura (32.5) and leaderboard (32.12)', () => {
  it('a 4-5 star rating gives the other person aura; it counts for the week board', async () => {
    const other = await createUniqueUser({ email: 'o@t.io', name: 'Other', gender: 'male' });
    const call = await Call.create({
      callerId: me.uid,
      calleeId: other._id,
      mode: 'audio',
      matchType: 'random',
      status: 'ended',
      durationSec: 120,
      startedAt: new Date(),
    });
    await callService.rateCall(me.uid, call._id, 5);
    assert.equal((await User.findById(other._id).lean()).aura, 2);
    const call2 = await Call.create({ ...call.toObject(), _id: undefined, ratings: [] });
    await callService.rateCall(String(other._id), call2._id, 2); // low rating: nothing
    assert.equal((await user()).aura, 0);

    await g.addAura(me.uid, 10, 'test');
    const board = (await api('get', '/goals/leaderboard')).body.data;
    assert.equal(board.week, '2026-W42');
    assert.deepEqual(
      board.items.map((i) => [i.user.name, i.aura]),
      [
        ['Gamer', 10],
        ['Other', 2],
      ],
    );
    assert.deepEqual(board.me, { rank: 1, aura: 10 });
  });
});

describe('goals (32.7 - 32.10)', () => {
  it('progress from talk, spins and messages; claim pays once', async () => {
    await g.recordConversation(me.uid, 11 * 60);
    await g.bump(me.uid, 'spins', 1);
    const data = (await api('get', '/goals')).body.data;
    const talk = data.daily.find((x) => x.id === 'talk_10');
    assert.deepEqual({ p: talk.progress, d: talk.done }, { p: 600, d: true });
    assert.equal(data.daily.find((x) => x.id === 'spin_1').done, true);
    assert.equal(data.daily.find((x) => x.id === 'connect_3').progress, 1);
    assert.equal(data.weekly.find((x) => x.id === 'talk_60').progress, 660);
    assert.equal(data.streak.current, 1);
    assert.equal(data.badges.length, 4);

    const claim = await api('post', '/goals/talk_10/claim');
    assert.equal(claim.status, 200);
    assert.deepEqual(claim.body.data.reward, { credits: 50, aura: 5 });
    assert.equal(claim.body.data.aura, 5);
    const u = await user();
    assert.deepEqual([u.credits, u.aura], [50, 5]);
    assert.equal((await api('post', '/goals/talk_10/claim')).body.code, 'GOAL_ALREADY_CLAIMED');
    assert.equal((await api('post', '/goals/messages_20/claim')).body.code, 'GOAL_NOT_DONE');
    assert.equal((await api('post', '/goals/nope/claim')).status, 404);
    assert.equal(
      (await api('get', '/goals')).body.data.daily.find((x) => x.id === 'talk_10').claimed,
      true,
    );
  });

  it('daily goals start fresh the next IST day, weekly ones on Monday', async () => {
    at('2026-10-11T23:58:00'); // Sunday
    await g.bump(me.uid, 'messages', 20);
    at('2026-10-12T00:02:00'); // Monday
    const data = (await api('get', '/goals')).body.data;
    assert.equal(data.daily.find((x) => x.id === 'messages_20').progress, 0);
    assert.equal(data.weekly.find((x) => x.id === 'messages_150').progress, 0);
    assert.equal(istDayKey(clock), '2026-10-12');
  });

  it('sending a chat message counts', async () => {
    const other = await createUniqueUser({ email: 'o@t.io', name: 'Other', gender: 'male' });
    const chat = require('../src/services/chat.service');
    await chat.sendMessage(me.uid, { toUserId: String(other._id), text: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      Number(await redis.get(g.keys.counter(me.uid, `d:${istDayKey(clock)}`, 'messages'))),
      1,
    );
  });
});
