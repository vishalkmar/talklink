// Phase 36: signed media uploads, voice messages, view-once messages, media purge.
// Cloudinary is never called: fake cloud settings + a fake destroy transport.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Message, User } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const chat = require('../src/services/chat.service');
const media = require('../src/services/media.service');
const push = require('../src/services/push.service');
const EVENTS = require('../src/constants/socketEvents.json');

const CLOUD = { cloudName: 'testcloud', apiKey: '111', apiSecret: 'shh' };
const saved = { ...media.settings };

let server;
let url;
let pushes;
let destroyed;
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
const makeUser = async (email, name) => {
  const user = await createUniqueUser({ email, name, gender: 'female' });
  return { user, uid: String(user._id), token: signAccessToken(user._id) };
};
const api = (u, method, path) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${u.token}`);
// what Cloudinary would return for a file in that user's folder
const upload = (uid, name = 'v1') => ({
  publicId: `talklink/chat-audio/${uid}/${name}`,
  url: `https://res.cloudinary.com/testcloud/video/upload/v1700000000/talklink/chat-audio/${uid}/${name}.m4a`,
  durationSec: 7,
});

let riya;
let sourav;

before(async () => {
  presence.settings.offlineGraceMs = 100;
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  Object.assign(media.settings, CLOUD);
  destroyed = [];
  media.__setTransportForTests(async (endpoint, form) => {
    destroyed.push({ endpoint, publicId: form.public_id });
    return { status: 200, data: { result: 'ok' } };
  });
  pushes = [];
  push.__setTransportForTests(async (msg) => {
    pushes.push(msg);
    return 'id';
  });
  chat.__clearCacheForTests();
  riya = await makeUser('riya@t.io', 'Riya');
  sourav = await makeUser('sourav@t.io', 'Sourav');
  riya.s = await connect(riya.token);
  sourav.s = await connect(sourav.token);
  await sleep(50);
});

afterEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  push.__setTransportForTests(null);
  Object.assign(media.settings, saved);
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

const send = (from, body) => ack(from.s, EVENTS.CHAT_SEND, body);

describe('signed uploads (36.1)', () => {
  it('signs a user-scoped folder; unknown kinds and missing keys are refused', async () => {
    const res = await api(riya, 'post', '/media/sign').send({ kind: 'chat_audio' });
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.folder, `talklink/chat-audio/${riya.uid}`);
    assert.equal(d.uploadUrl, 'https://api.cloudinary.com/v1_1/testcloud/video/upload');
    assert.equal(d.apiKey, '111');
    const expected = crypto
      .createHash('sha1')
      .update(`folder=${d.folder}&timestamp=${d.timestamp}shh`)
      .digest('hex');
    assert.equal(d.signature, expected);
    assert.equal(JSON.stringify(res.body).includes('shh'), false); // the secret never leaves

    assert.equal((await api(riya, 'post', '/media/sign').send({ kind: 'pdf' })).status, 400);
    media.settings.apiSecret = '';
    const off = await api(riya, 'post', '/media/sign').send({ kind: 'chat_audio' });
    assert.equal(off.body.code, 'MEDIA_UNAVAILABLE');
  });
});

describe('voice messages (36.2)', () => {
  it('sends a voice note; lists and pushes show a label, not a file', async () => {
    const res = await send(riya, { toUserId: sourav.uid, audio: upload(riya.uid) });
    assert.equal(res.ok, true);
    assert.equal(res.message.type, 'audio');
    assert.equal(res.message.audio.durationSec, 7);
    assert.ok(res.message.audio.url.includes('/chat-audio/'));
    const incoming = await waitFor(sourav.s, EVENTS.CHAT_NEW);
    assert.equal(incoming.message.audio.url, res.message.audio.url);

    const list = (await api(sourav, 'get', '/chats')).body.data.items;
    assert.equal(list[0].lastMessage.text, chat.PREVIEW.audio);
    const history = (await api(sourav, 'get', `/chats/${res.conversationId}/messages`)).body.data;
    assert.equal(history.items[0].type, 'audio');
  });

  it("refuses files from another user's folder, other clouds, too long, text + audio", async () => {
    const other = await send(riya, { toUserId: sourav.uid, audio: upload(sourav.uid) });
    assert.equal(other.code, 'INVALID_MEDIA');
    const foreign = await send(riya, {
      toUserId: sourav.uid,
      audio: { ...upload(riya.uid), url: 'https://evil.example/x.m4a' },
    });
    assert.equal(foreign.code, 'INVALID_MEDIA');
    const long = await send(riya, {
      toUserId: sourav.uid,
      audio: { ...upload(riya.uid), durationSec: 500 },
    });
    assert.equal(long.code, 'AUDIO_TOO_LONG');
    const both = await send(riya, { toUserId: sourav.uid, text: 'hi', audio: upload(riya.uid) });
    assert.equal(both.code, 'VALIDATION_ERROR');
  });
});

describe('view once (36.6 - 36.9)', () => {
  it('the receiver gets no content until opening it; it opens once; the sender hears about it', async () => {
    await User.updateOne(
      { _id: sourav.uid },
      { $set: { fcmToken: 'tok-sourav-0123456789012345' } },
    );
    const sent = await send(riya, { toUserId: sourav.uid, text: 'secret plan', viewOnce: true });
    assert.equal(sent.message.text, 'secret plan'); // my own copy
    assert.equal(sent.message.viewOnce, true);
    const incoming = await waitFor(sourav.s, EVENTS.CHAT_NEW);
    assert.equal(incoming.message.text, '');
    assert.equal(incoming.message.viewOnce, true);

    const convId = sent.conversationId;
    const before = (await api(sourav, 'get', `/chats/${convId}/messages`)).body.data.items[0];
    assert.equal(before.text, '');
    assert.equal(
      (await api(sourav, 'get', '/chats')).body.data.items[0].lastMessage.text,
      chat.PREVIEW.viewOnce,
    );

    // the sender can't open it, the receiver can - once
    const mine = await ack(riya.s, EVENTS.CHAT_OPEN_ONCE, {
      conversationId: convId,
      messageId: sent.message.id,
    });
    assert.equal(mine.ok, false);
    const opened = await ack(sourav.s, EVENTS.CHAT_OPEN_ONCE, {
      conversationId: convId,
      messageId: sent.message.id,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.text, 'secret plan');
    const again = await ack(sourav.s, EVENTS.CHAT_OPEN_ONCE, {
      conversationId: convId,
      messageId: sent.message.id,
    });
    assert.equal(again.code, 'ALREADY_OPENED');

    const told = await waitFor(riya.s, EVENTS.CHAT_OPENED);
    assert.equal(told.messageId, sent.message.id);
    // gone for both, also in the database
    const after_ = (await api(riya, 'get', `/chats/${convId}/messages`)).body.data.items[0];
    assert.equal(after_.text, '');
    assert.ok(after_.openedAt);
    assert.equal((await Message.findById(sent.message.id).lean()).text, '');
  });

  it('a view-once voice note: no url before opening, file deleted after', async () => {
    const sent = await send(riya, {
      toUserId: sourav.uid,
      audio: upload(riya.uid, 'once'),
      viewOnce: true,
    });
    const incoming = await waitFor(sourav.s, EVENTS.CHAT_NEW);
    assert.equal(incoming.message.audio.url, null);
    assert.equal(incoming.message.audio.durationSec, 7);
    const opened = await ack(sourav.s, EVENTS.CHAT_OPEN_ONCE, {
      conversationId: sent.conversationId,
      messageId: sent.message.id,
    });
    assert.ok(opened.audio.url.endsWith('once.m4a'));

    // not purged before the play window ends, purged after
    assert.equal(await chat.purgeMedia(new Date()), null);
    const res = await chat.purgeMedia(new Date(Date.now() + 11 * 60 * 1000));
    assert.deepEqual(res, { purged: 1 });
    assert.equal(destroyed[0].publicId, `talklink/chat-audio/${riya.uid}/once`);
    assert.ok(destroyed[0].endpoint.endsWith('/testcloud/video/destroy'));
    const doc = await Message.findById(sent.message.id).lean();
    assert.equal(doc.audio.publicId, undefined);
    assert.equal(doc.audio.url, undefined);
  });

  it('push previews never carry the content', async () => {
    await User.updateOne(
      { _id: sourav.uid },
      { $set: { fcmToken: 'tok-sourav-0123456789012345' } },
    );
    sourav.s.disconnect();
    await sleep(250);
    await send(riya, { toUserId: sourav.uid, text: 'do not leak', viewOnce: true });
    await sleep(100);
    const p = pushes.find((x) => x.data.type === 'new_message');
    assert.ok(p, 'push sent');
    assert.equal(p.data.preview, chat.PREVIEW.viewOnce);
    assert.equal(JSON.stringify(p).includes('do not leak'), false);
  });
});
