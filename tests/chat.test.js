// Phase 23: text chat backend - send, deliver, seen, typing, blocked, duplicate, REST.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const { Conversation, Message, Block, User } = require('../src/models');
const sockets = require('../src/sockets');
const presence = require('../src/services/presence.service');
const chat = require('../src/services/chat.service');
const push = require('../src/services/push.service');
const EVENTS = require('../src/constants/socketEvents.json');

let server;
let url;
let pushes;
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
  pushes = [];
  push.__setTransportForTests(async (msg) => {
    pushes.push(msg);
    return 'id';
  });
  chat.__clearCacheForTests();
  riya = await makeUser('riya@t.io', 'Riya');
  sourav = await makeUser('sourav@t.io', 'Sourav');
  await User.updateOne({ _id: sourav.uid }, { $set: { fcmToken: 'tok-sourav-0123456789012345' } });
  riya.s = await connect(riya.token);
  sourav.s = await connect(sourav.token);
  await sleep(50);
});

afterEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await sleep(60);
  presence.__clearTimersForTests();
  push.__setTransportForTests(null);
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

const send = (from, body) => ack(from.s, EVENTS.CHAT_SEND, body);

describe('chat:send (23.2 - 23.6, 23.10)', () => {
  it('first message creates the conversation and reaches the receiver', async () => {
    const res = await send(riya, {
      toUserId: sourav.uid,
      text: '  Hi Sourav!  ',
      clientMsgId: 'c1',
    });
    assert.equal(res.ok, true);
    assert.equal(res.message.text, 'Hi Sourav!');
    assert.equal(res.message.status, 'sent');
    assert.equal(res.message.senderId, riya.uid);
    const incoming = await waitFor(sourav.s, EVENTS.CHAT_NEW);
    assert.equal(incoming.message.id, res.message.id);
    assert.equal(incoming.sender.name, 'Riya');
    assert.equal(incoming.conversation.id, res.conversationId);

    const conv = await Conversation.findById(res.conversationId).lean();
    assert.equal(conv.lastMessage.text, 'Hi Sourav!');
    assert.equal(conv.unreadCount[sourav.uid], 1);

    // reply goes into the same conversation (by user id or by conversation id)
    const r2 = await send(sourav, { toUserId: riya.uid, text: 'Hello' });
    assert.equal(r2.conversationId, res.conversationId);
    const r3 = await send(riya, { conversationId: res.conversationId, text: 'How are you?' });
    assert.equal(r3.ok, true);
    assert.equal(await Conversation.countDocuments(), 1);
    const after2 = await Conversation.findById(res.conversationId).lean();
    assert.equal(after2.unreadCount[sourav.uid], 2);
    assert.equal(after2.unreadCount[riya.uid], 1);
  });

  it('the same clientMsgId twice is stored once (23.15)', async () => {
    const a = await send(riya, { toUserId: sourav.uid, text: 'once', clientMsgId: 'dup-1' });
    const b = await send(riya, { toUserId: sourav.uid, text: 'once', clientMsgId: 'dup-1' });
    assert.equal(b.duplicate, true);
    assert.equal(b.message.id, a.message.id);
    assert.equal(await Message.countDocuments(), 1);
  });

  it('validates and cleans text (23.5 / 23.17)', async () => {
    assert.equal((await send(riya, { toUserId: sourav.uid, text: '   ' })).code, 'EMPTY_MESSAGE');
    assert.equal(
      (await send(riya, { toUserId: sourav.uid, text: 'x'.repeat(1001) })).code,
      'MESSAGE_TOO_LONG',
    );
    assert.equal((await send(riya, { text: 'no target' })).code, 'VALIDATION_ERROR');
    assert.equal(
      (await send(riya, { toUserId: riya.uid, text: 'me' })).code,
      'CANNOT_MESSAGE_SELF',
    );
    const res = await send(riya, { toUserId: sourav.uid, text: 'you f​uck1ng idiot www.x.com' });
    assert.equal(res.message.text, 'you f****** idiot www.x.com'); // links ok in private chats
  });

  it('blocked either way -> refused (23.4)', async () => {
    const first = await send(riya, { toUserId: sourav.uid, text: 'hi' });
    await Block.create({ blockerId: sourav.uid, blockedId: riya.uid });
    const byId = await send(riya, { conversationId: first.conversationId, text: 'hello?' });
    assert.equal(byId.code, 'CHAT_NOT_ALLOWED');
    const byUser = await send(riya, { toUserId: sourav.uid, text: 'hello?' });
    assert.equal(byUser.code, 'USER_NOT_FOUND');
    const reverse = await send(sourav, { conversationId: first.conversationId, text: 'x' });
    assert.equal(reverse.code, 'CHAT_NOT_ALLOWED');
    assert.equal(await Message.countDocuments(), 1);
  });

  it('random sessions: no links, nothing after the session ended (23.16)', async () => {
    const conv = await Conversation.create({
      participants: [riya.uid, sourav.uid],
      participantsKey: Conversation.keyFor(riya.uid, sourav.uid),
      isRandomSession: true,
    });
    const id = String(conv._id);
    assert.equal(
      (await send(riya, { conversationId: id, text: 'join https://spam.example' })).code,
      'LINK_NOT_ALLOWED',
    );
    assert.equal((await send(riya, { conversationId: id, text: 'hey' })).ok, true);
    const expiresAt = await chat.scheduleEphemeralDelete(id, new Date());
    assert.ok(expiresAt > new Date(Date.now() + 23 * 3600 * 1000));
    assert.ok((await Message.findOne({ conversationId: id }).lean()).expiresAt);
    assert.equal(
      (await send(riya, { conversationId: id, text: 'still there?' })).code,
      'CHAT_ENDED',
    );
    // random sessions are not in the chat list
    const list = await api(riya, 'get', '/chats');
    assert.equal(list.body.data.items.length, 0);
  });

  it('offline receiver gets a push with name and preview (23.14)', async () => {
    sourav.s.disconnect();
    await sleep(80);
    await send(riya, { toUserId: sourav.uid, text: `long ${'y'.repeat(100)}` });
    await sleep(50);
    const [p] = pushes.filter((m) => m.data.type === 'new_message');
    assert.equal(p.data.senderName, 'Riya');
    assert.equal(p.data.preview.length, 80);
    assert.ok(p.data.preview.endsWith('…'));
  });

  it('online receiver gets no push', async () => {
    await send(riya, { toUserId: sourav.uid, text: 'hi' });
    await sleep(50);
    assert.equal(pushes.length, 0);
  });
});

describe('ticks and typing (23.7 - 23.9)', () => {
  it('delivered then seen notify the sender; unread resets', async () => {
    const a = await send(riya, { toUserId: sourav.uid, text: 'one' });
    const b = await send(riya, { conversationId: a.conversationId, text: 'two' });
    const conversationId = a.conversationId;

    const d = await ack(sourav.s, EVENTS.CHAT_DELIVERED, {
      conversationId,
      messageIds: [a.message.id, b.message.id],
    });
    assert.equal(d.count, 2);
    const delivered = await waitFor(riya.s, EVENTS.CHAT_DELIVERED);
    assert.deepEqual(delivered.messageIds.sort(), [a.message.id, b.message.id].sort());
    // the sender can't mark its own messages
    assert.equal(
      (await ack(riya.s, EVENTS.CHAT_DELIVERED, { conversationId, messageIds: [a.message.id] }))
        .count,
      0,
    );

    const seen = await ack(sourav.s, EVENTS.CHAT_SEEN, { conversationId });
    assert.equal(seen.count, 2);
    const s = await waitFor(riya.s, EVENTS.CHAT_SEEN);
    assert.equal(s.conversationId, conversationId);
    assert.equal(s.messageIds.length, 2);
    const msgs = await Message.find().lean();
    assert.ok(msgs.every((m) => m.status === 'seen' && m.seenAt && m.deliveredAt));
    const conv = await Conversation.findById(conversationId).lean();
    assert.equal(conv.unreadCount[sourav.uid], 0);
    // seen again: nothing new, no event to the sender
    riya.s.received = [];
    assert.equal((await ack(sourav.s, EVENTS.CHAT_SEEN, { conversationId })).count, 0);
    await sleep(60);
    assert.equal(got(riya.s, EVENTS.CHAT_SEEN).length, 0);
  });

  it('typing goes only to the other participant; strangers are refused', async () => {
    const a = await send(riya, { toUserId: sourav.uid, text: 'hi' });
    assert.equal(
      (await ack(riya.s, EVENTS.CHAT_TYPING, { conversationId: a.conversationId })).ok,
      true,
    );
    const t = await waitFor(sourav.s, EVENTS.CHAT_TYPING);
    assert.deepEqual(t, { conversationId: a.conversationId, from: riya.uid });
    await ack(riya.s, EVENTS.CHAT_STOP_TYPING, { conversationId: a.conversationId });
    await waitFor(sourav.s, EVENTS.CHAT_STOP_TYPING);
    assert.equal(got(riya.s, EVENTS.CHAT_TYPING).length, 0);

    const meera = await makeUser('meera@t.io', 'Meera');
    meera.s = await connect(meera.token);
    assert.equal(
      (await ack(meera.s, EVENTS.CHAT_TYPING, { conversationId: a.conversationId })).code,
      'CHAT_NOT_FOUND',
    );
    assert.equal(
      (await send(meera, { conversationId: a.conversationId, text: 'let me in' })).code,
      'CHAT_NOT_FOUND',
    );
  });
});

describe('REST /chats (23.11 - 23.13)', () => {
  it('lists my chats with peer, last message and unread counts', async () => {
    const meera = await makeUser('meera@t.io', 'Meera');
    meera.s = await connect(meera.token);
    await send(sourav, { toUserId: riya.uid, text: 'from sourav' });
    await sleep(5);
    await send(meera, { toUserId: riya.uid, text: 'from meera 1' });
    await send(meera, { toUserId: riya.uid, text: 'from meera 2' });

    const res = await api(riya, 'get', '/chats');
    assert.equal(res.status, 200);
    const { items, totalUnread, nextCursor } = res.body.data;
    assert.equal(items.length, 2);
    assert.equal(items[0].peer.name, 'Meera');
    assert.equal(items[0].lastMessage.text, 'from meera 2');
    assert.equal(items[0].lastMessage.mine, false);
    assert.equal(items[0].unreadCount, 2);
    assert.equal(items[1].unreadCount, 1);
    assert.equal(totalUnread, 3);
    assert.equal(nextCursor, null);
    assert.equal(items[0].peer.email, undefined);

    const page1 = await api(riya, 'get', '/chats?limit=1');
    assert.equal(page1.body.data.items.length, 1);
    const page2 = await api(riya, 'get', `/chats?limit=1&cursor=${page1.body.data.nextCursor}`);
    assert.equal(page2.body.data.items[0].peer.name, 'Sourav');
  });

  it('messages: newest first, 30 per page, `before` pages back; only participants', async () => {
    const first = await send(riya, { toUserId: sourav.uid, text: 'm0' });
    const cid = first.conversationId;
    for (let i = 1; i < 35; i += 1) {
      await Message.create({
        conversationId: cid,
        senderId: riya.uid,
        text: `m${i}`,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    const p1 = await api(sourav, 'get', `/chats/${cid}/messages`);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.data.items.length, 30);
    assert.equal(p1.body.data.items[0].text, 'm34');
    assert.equal(p1.body.data.conversation.peer.name, 'Riya');
    const p2 = await api(sourav, 'get', `/chats/${cid}/messages?before=${p1.body.data.nextBefore}`);
    assert.equal(p2.body.data.items.length, 5);
    assert.equal(p2.body.data.items[4].text, 'm0');
    assert.equal(p2.body.data.nextBefore, null);

    const meera = await makeUser('meera@t.io', 'Meera');
    assert.equal((await api(meera, 'get', `/chats/${cid}/messages`)).status, 404);
    assert.equal((await api(sourav, 'get', `/chats/${cid}/messages?before=nope`)).status, 400);
  });

  it('delete for me: gone from my list and history until a new message arrives', async () => {
    const first = await send(sourav, { toUserId: riya.uid, text: 'old message' });
    const cid = first.conversationId;
    const del = await api(riya, 'delete', `/chats/${cid}`);
    assert.equal(del.status, 200);
    assert.equal((await api(riya, 'get', '/chats')).body.data.items.length, 0);
    assert.equal((await api(sourav, 'get', '/chats')).body.data.items.length, 1); // only for me

    await sleep(5);
    await send(sourav, { toUserId: riya.uid, text: 'new message' });
    const list = (await api(riya, 'get', '/chats')).body.data.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].unreadCount, 1);
    const history = (await api(riya, 'get', `/chats/${cid}/messages`)).body.data.items;
    assert.deepEqual(
      history.map((m) => m.text),
      ['new message'],
    );
    // the other person still sees everything
    const theirs = (await api(sourav, 'get', `/chats/${cid}/messages`)).body.data.items;
    assert.equal(theirs.length, 2);
  });
});

describe('chat room extras (Phase 24)', () => {
  it('history tells the app online / blocked / canReply', async () => {
    const first = await send(riya, { toUserId: sourav.uid, text: 'hi' });
    const cid = first.conversationId;
    let conv = (await api(riya, 'get', `/chats/${cid}/messages`)).body.data.conversation;
    assert.deepEqual(
      { online: conv.online, blockedByMe: conv.blockedByMe, canReply: conv.canReply },
      { online: true, blockedByMe: false, canReply: true },
    );

    assert.equal((await api(riya, 'post', '/blocks').send({ userId: sourav.uid })).status, 200);
    conv = (await api(riya, 'get', `/chats/${cid}/messages`)).body.data.conversation;
    assert.equal(conv.blockedByMe, true);
    assert.equal(conv.canReply, false);
    // the blocked person sees "can't reply" but not that they were blocked, and not online
    const theirs = (await api(sourav, 'get', `/chats/${cid}/messages`)).body.data.conversation;
    assert.deepEqual(
      { online: theirs.online, blockedByMe: theirs.blockedByMe, canReply: theirs.canReply },
      { online: false, blockedByMe: false, canReply: false },
    );

    const un = await api(riya, 'delete', `/blocks/${sourav.uid}`);
    assert.deepEqual(un.body.data, { unblocked: true, userId: sourav.uid });
    assert.equal((await send(riya, { conversationId: cid, text: 'back' })).ok, true);
    assert.equal((await api(riya, 'delete', `/blocks/${sourav.uid}`)).body.data.unblocked, false);
  });

  it('clear chat keeps it in the list; delete one message for me', async () => {
    const a = await send(riya, { toUserId: sourav.uid, text: 'one' });
    const b = await send(riya, { conversationId: a.conversationId, text: 'two' });
    const cid = a.conversationId;

    const del = await api(sourav, 'delete', `/chats/${cid}/messages/${a.message.id}`);
    assert.equal(del.status, 200);
    let mine = (await api(sourav, 'get', `/chats/${cid}/messages`)).body.data.items;
    assert.deepEqual(
      mine.map((m) => m.text),
      ['two'],
    );
    // only for me
    assert.equal((await api(riya, 'get', `/chats/${cid}/messages`)).body.data.items.length, 2);
    assert.equal(
      (await api(sourav, 'delete', `/chats/${cid}/messages/64b000000000000000000000`)).status,
      404,
    );

    await sleep(5);
    assert.equal((await api(sourav, 'post', `/chats/${cid}/clear`)).status, 200);
    mine = (await api(sourav, 'get', `/chats/${cid}/messages`)).body.data.items;
    assert.equal(mine.length, 0);
    const list = (await api(sourav, 'get', '/chats')).body.data.items;
    assert.equal(list.length, 1); // still listed
    assert.equal(list[0].unreadCount, 0);
    assert.equal(list[0].lastMessage, null);
    assert.ok(b.ok);
  });
});
