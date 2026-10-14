const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { connectTestDeps, closeTestDeps } = require('./helpers/db');

before(connectTestDeps);
after(closeTestDeps);

describe('GET /health', () => {
  it('returns status, version, uptime and Mongo/Redis state', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'ok');
    assert.equal(typeof res.body.data.version, 'string');
    assert.equal(typeof res.body.data.uptimeSec, 'number');
    assert.deepEqual(res.body.data.dependencies, { mongo: 'up', redis: 'up' });
  });

  it('echoes a request id header', async () => {
    const res = await request(app).get('/health');
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });
});

describe('error format', () => {
  it('returns { success:false, code, message } for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'ROUTE_NOT_FOUND');
    assert.equal(typeof res.body.message, 'string');
  });

  it('rejects malformed JSON with INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_JSON');
  });
});
