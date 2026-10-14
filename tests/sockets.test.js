// Phase 13: Socket.IO infrastructure - integration test with real clients (13.18).
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const config = require('../src/config');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');
const { createUniqueUser } = require('../src/utils/privateNumber');
const { signAccessToken } = require('../src/services/token.service');
const sockets = require('../src/sockets');
const registry = require('../src/sockets/registry');
const { RATE_LIMITS } = require('../src/sockets/helpers');
const EVENTS = require('../src/constants/socketEvents.json');

let server;
let url;
const clients = [];

const connect = (token, { expectError = false } = {}) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: token === undefined ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    socket.on('connect', () => (expectError ? reject(new Error('connected')) : resolve(socket)));
    socket.on('connect_error', (err) => (expectError ? resolve(err) : reject(err)));
  });

const waitFor = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (...args) => {
      clearTimeout(t);
      resolve(args);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await connectTestDeps();
  server = http.createServer(app);
  sockets.initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await sleep(50);
  await resetTestDeps();
});

after(async () => {
  await sockets.closeSockets();
  await closeTestDeps();
});

const makeUser = async (email) => {
  const user = await createUniqueUser({ email, name: 'Riya', gender: 'female' });
  return { user, token: signAccessToken(user._id) };
};

describe('socket authentication', () => {
  it('rejects a connection without a token', async () => {
    const err = await connect(undefined, { expectError: true });
    assert.equal(err.data.code, 'UNAUTHORIZED');
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const { user } = await makeUser('exp@t.io');
    const expired = jwt.sign(
      { typ: 'access', exp: Math.floor(Date.now() / 1000) - 5 },
      config.jwt.accessSecret,
      { subject: String(user._id) },
    );
    const err = await connect(expired, { expectError: true });
    assert.equal(err.data.code, 'TOKEN_EXPIRED');
  });

  it('rejects garbage tokens and suspended accounts', async () => {
    assert.equal((await connect('abc.def.ghi', { expectError: true })).data.code, 'INVALID_TOKEN');
    const { user, token } = await makeUser('sus@t.io');
    user.status = 'suspended';
    await user.save();
    assert.equal((await connect(token, { expectError: true })).data.code, 'ACCOUNT_SUSPENDED');
  });
});

describe('rooms and devices', () => {
  it("delivers to every device of the user and nobody else's", async () => {
    const a = await makeUser('a@t.io');
    const b = await makeUser('b@t.io');
    const [a1, a2, b1] = await Promise.all([connect(a.token), connect(a.token), connect(b.token)]);
    await sleep(50);

    assert.equal(await registry.socketCount(String(a.user._id)), 2);
    assert.equal(await registry.socketCount(String(b.user._id)), 1);

    let bGot = false;
    b1.on('test:hello', () => {
      bGot = true;
    });
    const got = Promise.all([waitFor(a1, 'test:hello'), waitFor(a2, 'test:hello')]);
    sockets.emitToUser(String(a.user._id), 'test:hello', { x: 1 });
    const [[m1], [m2]] = await got;
    assert.deepEqual(m1, { x: 1 });
    assert.deepEqual(m2, { x: 1 });
    await sleep(50);
    assert.equal(bGot, false);

    a1.disconnect();
    await sleep(100);
    assert.equal(await registry.socketCount(String(a.user._id)), 1);
  });

  it('disconnectUser() closes every socket of that account', async () => {
    const a = await makeUser('d@t.io');
    const [s1, s2] = await Promise.all([connect(a.token), connect(a.token)]);
    const gone = Promise.all([waitFor(s1, 'disconnect'), waitFor(s2, 'disconnect')]);
    sockets.disconnectUser(String(a.user._id));
    const [[r1], [r2]] = await gone;
    assert.equal(r1, 'io server disconnect');
    assert.equal(r2, 'io server disconnect');
  });
});

describe('acks and rate limits', () => {
  it('system:ping answers with an ack', async () => {
    const a = await makeUser('p@t.io');
    const s = await connect(a.token);
    const res = await s.timeout(2000).emitWithAck(EVENTS.SYSTEM_PING, {});
    assert.equal(res.ok, true);
    assert.equal(res.userId, String(a.user._id));
    assert.ok(Math.abs(res.serverTime - Date.now()) < 5000);
  });

  it('drops events over the per-user limit with RATE_LIMITED', async () => {
    const original = RATE_LIMITS[EVENTS.SYSTEM_PING];
    RATE_LIMITS[EVENTS.SYSTEM_PING] = [3, 60];
    try {
      const a = await makeUser('rl@t.io');
      const s = await connect(a.token);
      const results = [];
      for (let i = 0; i < 4; i += 1) {
        results.push(await s.timeout(2000).emitWithAck(EVENTS.SYSTEM_PING, {}));
      }
      assert.deepEqual(
        results.map((r) => r.ok),
        [true, true, true, false],
      );
      assert.equal(results[3].code, 'RATE_LIMITED');
    } finally {
      RATE_LIMITS[EVENTS.SYSTEM_PING] = original;
    }
  });
});

// The app keeps its own copy (App/src/constants/socketEvents.json). When this backend is checked
// out next to the App folder the two must match; in a backend-only repo the check is skipped.
const APP_EVENTS = path.join(__dirname, '../../App/src/constants/socketEvents.json');

describe('shared event names (13.11)', () => {
  it('backend and app use the same socket event list', { skip: !fs.existsSync(APP_EVENTS) }, () => {
    const app = JSON.parse(fs.readFileSync(APP_EVENTS, 'utf8'));
    assert.deepEqual(app, EVENTS);
  });
});
