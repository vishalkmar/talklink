// Phase 25: random text sessions - create, end, next, add to chats, idle, background, block.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Call, Conversation, Message, User } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const match = require('../src/services/match.service');
const sessions = require('../src/services/session.service');
const EVENTS = require('../src/constants/socketEvents.json');

let server;
let url;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(s);
    s.received = [];
    s.onAny((event, payload) => s.received.push({ event, payload }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const ack = (s, event, payload) => s.timeout(3000).emitWithAck(event, payload);
const got = (s, event) => s.received.filter((r) => r.event === event).map((r) => r.payload);
const waitFor = (s, event, ms = 2500) =>
  new Promise((resolve, reject) => {
    const have = got(s, event);
    if (have.length) return resolve(have[have.length - 1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    return s.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

const person = async (email, gender = 'female') => {
  const user = await createUniqueUser({ email, name: `User ${email.split('@')[0]}`, gender });
  const token = signAccessToken(user._id);
  const s = await connect(token);
  await sleep(40);
  await ack(s, EVENTS.PRESENCE_SET, { available: true, foreground: true });
  return { user, uid: String(user._id), s, token };
};

// a text match between a (caller) and b
const textMatch = async (a, b) => {
  const req = await ack(a.s, EVENTS.MATCH_REQUEST, { mode: 'text' });
  await waitFor(b.s, EVENTS.MATCH_INCOMING);
  const res = await ack(b.s, EVENTS.MATCH_ACCEPT, { requestId: req.requestId });
  const found = await waitFor(a.s, EVENTS.MATCH_FOUND);
  return { res, found, conversationId: found.conversationId, callId: found.roomId };
};

let a;
let b;

before(async () => {
  Object.assign(match.settings, { waveIntervalMs: 200, timeoutMs: 1500, waveSize: 20 });
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  Object.assign(sessions.settings, {
    idleMs: 60000,
    backgroundGraceMs: 60000,
    safetyWindowMs: 120000,
  });
  a = await person('a@t.io');
  b = await person('b@t.io', 'male');
});

afterEach(async () => {
  match.__resetForTests();
  sessions.__resetForTests();
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

describe('session start (25.1 / 25.2)', () => {
  it('a text match opens a temporary chat both can use', async () => {
    const { res, found, conversationId, callId } = await textMatch(a, b);
    assert.ok(conversationId);
    assert.equal(res.conversationId, conversationId);
    assert.equal(found.mode, 'text');
    const conv = await Conversation.findById(conversationId).lean();
    assert.equal(conv.isRandomSession, true);
    assert.equal(String((await Call.findById(callId).lean()).conversationId), conversationId);

    const sent = await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'hey stranger' });
    assert.equal(sent.ok, true);
    const incoming = await waitFor(b.s, EVENTS.CHAT_NEW);
    assert.equal(incoming.conversation.isRandomSession, true);
  });

  it('no phone numbers in the first 2 minutes; links never (25.12)', async () => {
    const { conversationId } = await textMatch(a, b);
    const phone = await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'call me 98765 43210' });
    assert.equal(phone.code, 'PHONE_NOT_ALLOWED');
    const plus = await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: '+91-9876543210' });
    assert.equal(plus.code, 'PHONE_NOT_ALLOWED');
    assert.equal(
      (await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'I am 22, from Pune' })).ok,
      true,
    );
    sessions.settings.safetyWindowMs = 0;
    assert.equal(
      (await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'ok 9876543210' })).ok,
      true,
    );
  });
});

describe('ending (25.5 / 25.6 / 25.8 - 25.10)', () => {
  it('End: both get session:ended with the system message; input closes; chat expires', async () => {
    const { conversationId, callId } = await textMatch(a, b);
    await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'hi' });
    const res = await ack(b.s, EVENTS.SESSION_END, { conversationId });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'ended');
    const ended = await waitFor(a.s, EVENTS.SESSION_ENDED);
    assert.equal(ended.endedBy, b.uid);
    assert.equal(ended.systemMessage.type, 'system');
    assert.equal(ended.systemMessage.text, 'Stranger left the chat');

    const conv = await Conversation.findById(conversationId).lean();
    assert.ok(conv.endedAt);
    assert.ok(conv.expiresAt > new Date(Date.now() + 23 * 3600000));
    const after = await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'wait' });
    assert.equal(after.code, 'CHAT_ENDED');

    const call = await Call.findById(callId).lean();
    assert.equal(call.status, 'ended');
    assert.equal(call.endReason, 'ended');
    assert.equal(typeof call.durationSec, 'number');
    assert.notEqual((await presence.getPresence(a.uid)).state, presence.STATE.IN_CHAT);
    // ending twice is harmless; outsiders can't end it
    assert.equal(
      (await ack(b.s, EVENTS.SESSION_END, { conversationId })).code,
      'SESSION_NOT_FOUND',
    );
  });

  it('aura for the session length (25.10)', async () => {
    const { conversationId, callId } = await textMatch(a, b);
    const { store } = require('../src/config/store');
    await store.hset(sessions.keys.session(conversationId), 'startedAt', Date.now() - 130000);
    await ack(a.s, EVENTS.SESSION_END, { conversationId });
    const call = await Call.findById(callId).lean();
    assert.ok(call.durationSec >= 130);
    assert.equal(call.auraEarned, 2);
    assert.equal((await User.findById(a.uid).lean()).aura, 2);
  });

  it('5 minutes without messages ends it (25.13); messages keep it alive', async () => {
    sessions.settings.idleMs = 300;
    const { conversationId } = await textMatch(a, b);
    await sleep(200);
    await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'still here' });
    await sleep(200);
    assert.equal(got(a.s, EVENTS.SESSION_ENDED).length, 0);
    const ended = await waitFor(a.s, EVENTS.SESSION_ENDED, 1500);
    assert.equal(ended.reason, 'idle');
  });

  it('a user who is gone for the grace time ends it (25.14); coming back in time keeps it', async () => {
    sessions.settings.backgroundGraceMs = 300;
    const { conversationId } = await textMatch(a, b);
    b.s.disconnect();
    await sleep(100);
    b.s = await connect(b.token); // back in time
    await sleep(400);
    assert.ok(await sessions.getSession(conversationId));

    b.s.disconnect();
    const ended = await waitFor(a.s, EVENTS.SESSION_ENDED, 2000);
    assert.equal(ended.reason, 'left');
    assert.equal(ended.endedBy, b.uid);
  });

  it('blocking ends the session (25.11)', async () => {
    const { conversationId } = await textMatch(a, b);
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ userId: b.uid });
    const ended = await waitFor(b.s, EVENTS.SESSION_ENDED);
    assert.equal(ended.reason, 'blocked');
    assert.equal(ended.conversationId, conversationId);
  });
});

describe('next (25.4 / 25.18)', () => {
  it('ends the session and searches again; rapid presses make no ghost sessions', async () => {
    const c = await person('c@t.io', 'male');
    const { conversationId } = await textMatch(a, b);
    const [first, second] = await Promise.all([
      ack(a.s, EVENTS.SESSION_NEXT, { conversationId }),
      ack(a.s, EVENTS.SESSION_NEXT, { conversationId }),
    ]);
    assert.equal(first.ok || second.ok, true);
    const failed = [first, second].find((r) => !r.ok);
    if (failed) assert.ok(['SESSION_NOT_FOUND', 'ALREADY_SEARCHING'].includes(failed.code));
    assert.equal((await waitFor(b.s, EVENTS.SESSION_ENDED)).reason, 'next');
    assert.equal((await presence.getPresence(a.uid)).state, presence.STATE.SEARCHING);

    // c gets the new request (b is "recent" and skipped)
    const { requestId } = first.ok ? first : second;
    let offer = null;
    for (let i = 0; i < 30 && !offer; i += 1) {
      offer = got(c.s, EVENTS.MATCH_INCOMING).find((o) => o.requestId === requestId);
      if (!offer) await sleep(50);
    }
    assert.ok(offer, 'c is offered the new request');
    const res = await ack(c.s, EVENTS.MATCH_ACCEPT, { requestId });
    assert.ok(res.conversationId);
    assert.notEqual(res.conversationId, conversationId);
    assert.equal(await Conversation.countDocuments({ isRandomSession: true }), 2);
    assert.equal(
      got(b.s, EVENTS.MATCH_INCOMING).filter((o) => o.requestId === requestId).length,
      0,
    );
  });
});

describe('add to chats (25.7)', () => {
  it('both must agree; then it is a permanent chat that never expires', async () => {
    const { conversationId } = await textMatch(a, b);
    await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'nice talking' });
    const first = await ack(a.s, EVENTS.SESSION_ADD, { conversationId });
    assert.deepEqual(
      { added: first.added, waiting: first.waiting },
      { added: false, waiting: true },
    );
    assert.equal((await waitFor(b.s, EVENTS.SESSION_ADD_REQUEST)).conversationId, conversationId);

    const second = await ack(b.s, EVENTS.SESSION_ADD, { conversationId });
    assert.equal(second.added, true);
    assert.equal(second.conversationId, conversationId);
    const added = await waitFor(a.s, EVENTS.SESSION_ADDED);
    assert.equal(added.conversationId, conversationId);

    const conv = await Conversation.findById(conversationId).lean();
    assert.equal(conv.isRandomSession, false);
    assert.equal(conv.expiresAt, undefined);
    assert.equal(conv.endedAt, undefined);
    // it is in the chat list now and they can keep talking
    const list = await request(app).get('/api/v1/chats').set('Authorization', `Bearer ${b.token}`);
    assert.equal(list.body.data.items.length, 1);
    assert.equal((await ack(b.s, EVENTS.CHAT_SEND, { conversationId, text: 'yes!' })).ok, true);
    assert.equal(got(a.s, EVENTS.SESSION_ENDED).length, 0);
    assert.notEqual((await presence.getPresence(a.uid)).state, presence.STATE.IN_CHAT);
  });

  it('merges into the chat they already had', async () => {
    const old = await ack(a.s, EVENTS.CHAT_SEND, { toUserId: b.uid, text: 'old chat' });
    const { conversationId } = await textMatch(a, b);
    await ack(b.s, EVENTS.CHAT_SEND, { conversationId, text: 'session msg' });
    await ack(a.s, EVENTS.SESSION_ADD, { conversationId });
    const res = await ack(b.s, EVENTS.SESSION_ADD, { conversationId });
    assert.equal(res.conversationId, old.conversationId);
    assert.equal(await Conversation.exists({ _id: conversationId }), null);
    const texts = (await Message.find({ conversationId: old.conversationId }).lean()).map(
      (m) => m.text,
    );
    assert.deepEqual(texts.sort(), ['old chat', 'session msg']);
  });

  it('not added -> session chats stay out of the list', async () => {
    const { conversationId } = await textMatch(a, b);
    await ack(a.s, EVENTS.CHAT_SEND, { conversationId, text: 'hi' });
    await ack(a.s, EVENTS.SESSION_END, { conversationId });
    const list = await request(app).get('/api/v1/chats').set('Authorization', `Bearer ${a.token}`);
    assert.equal(list.body.data.items.length, 0);
  });
});
