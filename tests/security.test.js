// Phase 34.3 security pass, kept as a test so it can't regress:
//  - every REST endpoint (read from the route files) refuses requests without a valid token,
//    except the short public list below
//  - admin endpoints need the admin key
//  - sockets refuse connections without a token
//  - error responses never leak stack traces; security headers are set
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../src/app');
const { connectTestDeps, resetTestDeps, closeTestDeps } = require('./helpers/db');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');

// Public on purpose (documented in docs/API.md / docs/SECURITY.md)
const PUBLIC = new Set([
  'POST /api/v1/auth/send-otp',
  'POST /api/v1/auth/verify-otp',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout', // takes the refresh token in the body
  'GET /api/v1/ads/ssv', // Google calls it; verified by ECDSA signature
  'POST /api/v1/payments/webhook', // Cashfree calls it; verified by HMAC signature
  'GET /api/v1/content/faq',
  'GET /health/',
  'GET /health/ping', // keep-alive, no data
]);

// [{ method, path }] for every router.METHOD('path', ...) in the route files
const listEndpoints = () => {
  const index = fs.readFileSync(path.join(ROUTES_DIR, 'index.js'), 'utf8');
  const fileOf = {};
  for (const m of index.matchAll(/const (\w+) = require\('\.\/([\w.]+)'\);/g)) fileOf[m[1]] = m[2];
  const mounts = [...index.matchAll(/router\.use\('([^']+)', (\w+)\)/g)].map((m) => ({
    prefix: `/api/v1${m[1]}`,
    file: fileOf[m[2]],
  }));
  mounts.push({ prefix: '/health', file: 'health.routes' });
  const out = [];
  for (const { prefix, file } of mounts) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, `${file}.js`), 'utf8');
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      out.push({ method: m[1].toUpperCase(), path: `${prefix}${m[2] === '/' ? '/' : m[2]}` });
    }
  }
  return out;
};

const fill = (p) => p.replace(/:\w+/g, '000000000000000000000000');
const send = (method, url) => request(app)[method.toLowerCase()](url);

before(connectTestDeps);
after(async () => {
  await resetTestDeps();
  await closeTestDeps();
});

describe('REST auth on every endpoint', () => {
  const endpoints = listEndpoints();

  it('finds the endpoints (sanity)', () => {
    assert.ok(endpoints.length >= 55, `only ${endpoints.length} endpoints found`);
    for (const pub of PUBLIC) {
      assert.ok(
        endpoints.some((e) => `${e.method} ${e.path}` === pub),
        `public endpoint ${pub} not found - update the list`,
      );
    }
  });

  it('no token / a bad token -> 401 (admin -> 401/404)', async () => {
    const problems = [];
    for (const e of endpoints) {
      const key = `${e.method} ${e.path}`;
      if (PUBLIC.has(key)) continue;
      const url = fill(e.path);
      const none = await send(e.method, url).send({});
      const bad = await send(e.method, url).set('Authorization', 'Bearer not.a.token').send({});
      const admin = e.path.startsWith('/api/v1/admin');
      const ok = (r) => r.status === 401 || (admin && r.status === 404);
      if (!ok(none) || !ok(bad)) problems.push(`${key} -> ${none.status}/${bad.status}`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('responses', () => {
  it('security headers, no stack traces, no x-powered-by', async () => {
    const res = await request(app).get('/api/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['strict-transport-security']);
    assert.equal(res.body.stack, undefined);
    const bad = await request(app)
      .post('/api/v1/auth/send-otp')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.body).includes('at '), 'stack trace leaked');
  });
});

describe('sockets', () => {
  let server;
  let url;
  before(async () => {
    const { initSockets } = require('../src/sockets');
    server = http.createServer(app);
    initSockets(server);
    await new Promise((r) => server.listen(0, r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    const { closeSockets } = require('../src/sockets');
    await closeSockets();
    await new Promise((r) => server.close(r));
  });

  const tryConnect = (auth) =>
    new Promise((resolve) => {
      const s = ioClient(url, {
        auth,
        transports: ['websocket'],
        reconnection: false,
        timeout: 3000,
      });
      s.on('connect', () => {
        s.close();
        resolve('connected');
      });
      s.on('connect_error', (err) => {
        s.close();
        resolve(err.message);
      });
    });

  it('refuses connections without a valid token', async () => {
    assert.notEqual(await tryConnect({}), 'connected');
    assert.notEqual(await tryConnect({ token: 'garbage' }), 'connected');
  });
});
