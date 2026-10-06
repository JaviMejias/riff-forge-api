const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-diagnostics-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { HttpError } = environment.load('services/httpError');
const secret = 'PRIVATE-diagnostics-fixture-token-password-song-content';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let server;
let baseUrl;
let token;
let entries;
let originalLog;

function report(response, event = 'request_failed') {
  const id = response.headers.get('x-request-id');
  assert.match(id, uuid);
  const matched = entries.map(args => {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], 'string');
    return JSON.parse(args[0]);
  }).filter(entry => entry.requestId === id);
  assert.equal(matched.length, 1);
  const entry = matched[0];
  assert.equal(entry.event, event);
  assert.equal(entry.level, 'error');
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  assert.equal(JSON.stringify(entries).includes(secret), false);
  assert.deepEqual(Object.keys(entry).sort(), [
    'durationMs', 'errorCategory', 'errorCode', 'event', 'level', 'method',
    'requestId', 'route', 'scope', 'status', 'timestamp'
  ].sort());
  return entry;
}

async function fixture(callback) {
  const fixtureApp = express();
  fixtureApp.use(environment.load('middleware/requestDiagnostics').requestDiagnostics);
  callback(fixtureApp);
  fixtureApp.use(environment.load('middleware/errorHandler').errorHandler);
  const fixtureServer = await new Promise(resolve => {
    const listening = fixtureApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    return await callback.request(`http://127.0.0.1:${fixtureServer.address().port}`);
  } finally {
    await new Promise(resolve => fixtureServer.close(resolve));
  }
}

test.before(async () => {
  const user = await prisma.user.create({ data: { email: 'diagnostics@example.test', passwordHash: 'unused' } });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.beforeEach(() => {
  entries = [];
  originalLog = console.error;
  console.error = (...args) => entries.push(args);
});

test.afterEach(() => { console.error = originalLog; });

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

test('every request gets a server-generated ID, exposed to cross-origin clients', async () => {
  const first = await fetch(baseUrl + '/health', { headers: { 'x-request-id': secret, origin: 'https://frontend.example.test' } });
  const second = await fetch(baseUrl + '/health');
  assert.match(first.headers.get('x-request-id'), uuid);
  assert.match(second.headers.get('x-request-id'), uuid);
  assert.notEqual(first.headers.get('x-request-id'), second.headers.get('x-request-id'));
  assert.match(first.headers.get('access-control-expose-headers'), /X-Request-ID/i);
  assert.deepEqual(await first.json(), { status: 'ok', message: 'Riff Forge API is running' });
  assert.equal(entries.length, 0);
});

test('unknown routes and rejected authentication keep IDs without logging user-controlled paths', async () => {
  for (const [url, status] of [['/' + secret + '?token=' + secret, 404], ['/api/songs', 401]]) {
    const response = await fetch(baseUrl + url);
    assert.equal(response.status, status);
    assert.match(response.headers.get('x-request-id'), uuid);
    await response.text();
  }
  assert.equal(entries.length, 0);
});

test('parser rejections have request IDs and preserve their existing response bodies', async () => {
  for (const [body, status, error] of [['{' + secret, 400, 'invalid_json'], [JSON.stringify({ value: secret.repeat(25000) }), 413, 'payload_too_large']]) {
    const response = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.match(response.headers.get('x-request-id'), uuid);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(entries.length, 0);
});

test('signup database failures retain the response contract without logging query or credentials', async () => {
  await prisma.$executeRawUnsafe("CREATE TRIGGER fail_diagnostics_signup BEFORE INSERT ON User BEGIN SELECT RAISE(FAIL, 'Diagnostics fixture failure'); END");
  try {
    const response = await fetch(baseUrl + '/api/auth/signup?token=' + secret, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
      body: JSON.stringify({ email: secret + '@example.test', password: secret, name: secret })
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Server error' });
    const entry = report(response);
    assert.equal(entry.scope, '/api/auth');
    assert.equal(entry.route, '/signup');
    assert.equal(entry.errorCategory, 'database_error');
    assert.match(entry.errorCode, /^P\d{4}$/);
    assert.equal(await prisma.user.count({ where: { email: secret + '@example.test' } }), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_diagnostics_signup');
  }
});

test('previously silent playlist failures have bounded diagnostics without leaking stored data', async () => {
  const userId = jwt.verify(token, process.env.JWT_SECRET).userId;
  const timestamp = BigInt(Date.now());
  const playlist = await prisma.playlist.create({ data: { userId, name: secret, songCloudIds: secret, createdAt: timestamp, updatedAt: timestamp } });
  try {
    const response = await fetch(baseUrl + '/api/playlists', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to fetch playlists' });
    const entry = report(response);
    assert.equal(entry.errorCategory, 'syntax_error');
    assert.equal(entry.route, '/playlists');
  } finally {
    await prisma.playlist.delete({ where: { id: playlist.id } });
  }
});

test('sync database failures log the response request ID and preserve transaction rollback', async () => {
  await prisma.$executeRawUnsafe("CREATE TRIGGER fail_diagnostics_sync BEFORE INSERT ON SyncChange BEGIN SELECT RAISE(FAIL, 'Diagnostics fixture failure'); END");
  const entityId = crypto.randomUUID();
  try {
    const response = await fetch(baseUrl + '/api/sync/v2', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ deviceId: crypto.randomUUID(), operations: [{
        operationId: crypto.randomUUID(), entityId, entityType: 'song', action: 'upsert', baseVersion: 0,
        data: { name: secret, textContent: secret }
      }] })
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'sync_failed' });
    assert.equal(report(response).errorCategory, 'database_error');
    assert.equal(await prisma.song.findUnique({ where: { id: entityId } }), null);
    assert.equal(await prisma.syncChange.count({ where: { entityId } }), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_diagnostics_sync');
  }
});

test('global error handling logs only a route template and safe category', async () => {
  const callback = fixtureApp => {
    fixtureApp.get('/files/:privateId', (_req, _res, next) => next(new TypeError(secret)));
  };
  callback.request = async url => {
    const response = await fetch(url + '/files/' + secret + '?token=' + secret);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
    const entry = report(response);
    assert.equal(entry.route, '/files/:privateId');
    assert.equal(entry.scope, 'unmatched');
    assert.equal(entry.errorCategory, 'type_error');
  };
  await fixture(callback);
});

test('structured HttpError responses preserve Retry-After and are logged once', async () => {
  const callback = fixtureApp => {
    fixtureApp.get('/busy', (_req, _res, next) => next(new HttpError(503, 'Servicio ocupado', { code: 'audio_capacity_exceeded', retryAfterSeconds: 5 })));
  };
  callback.request = async url => {
    const response = await fetch(url + '/busy');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), { error: 'Servicio ocupado', code: 'audio_capacity_exceeded', retryAfterSeconds: 5 });
    assert.equal(report(response).errorCategory, 'http_error');
  };
  await fixture(callback);
});

test('unclassified direct 500 responses are still logged once', async () => {
  const callback = fixtureApp => { fixtureApp.get('/direct', (_req, res) => res.status(500).json({ error: 'Original' })); };
  callback.request = async url => {
    const response = await fetch(url + '/direct');
    assert.deepEqual(await response.json(), { error: 'Original' });
    assert.equal(report(response).errorCategory, 'unclassified');
  };
  await fixture(callback);
});

test('arbitrary error strings and codes are not copied into diagnostic records', async () => {
  const callback = fixtureApp => {
    fixtureApp.get('/error/:privateId', (_req, _res, next) => next({ message: secret, name: secret, stack: secret, code: secret }));
  };
  callback.request = async url => {
    const response = await fetch(url + '/error/' + secret);
    assert.equal(response.status, 500);
    await response.json();
    const entry = report(response);
    assert.equal(entry.errorCategory, 'internal_error');
    assert.equal(entry.errorCode, null);
  };
  await fixture(callback);
});

test('error codes are read once before validation and never copied from a later getter value', async () => {
  let reads = 0;
  const callback = fixtureApp => {
    fixtureApp.get('/error', (_req, _res, next) => {
      const error = new Error(secret);
      Object.defineProperty(error, 'code', { get: () => ++reads <= 2 ? 'P2010' : secret });
      next(error);
    });
  };
  callback.request = async url => {
    const response = await fetch(url + '/error');
    assert.equal(response.status, 500);
    await response.json();
    assert.equal(report(response).errorCode, 'P2010');
    assert.equal(reads, 1);
  };
  await fixture(callback);
});

test('throwing error metadata getters cannot bypass the private error handler', async () => {
  const callback = fixtureApp => {
    fixtureApp.get('/error', (_req, _res, next) => {
      const error = new Error(secret);
      for (const field of ['code', 'type']) Object.defineProperty(error, field, { get: () => { throw new Error(secret); } });
      next(error);
    });
  };
  callback.request = async url => {
    const response = await fetch(url + '/error');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
    assert.equal(report(response).errorCategory, 'internal_error');
  };
  await fixture(callback);
});

for (const failAfterHeaders of [false, true]) test(`aborted streams are logged once without raw errors or invented 500s (server failure: ${failAfterHeaders})`, async () => {
  const callback = fixtureApp => {
    fixtureApp.get('/stream/:privateId', (_req, res, next) => {
      res.setHeader('content-type', 'text/plain');
      res.write(secret);
      if (failAfterHeaders) setTimeout(() => next(new TypeError(secret)), 10);
    });
  };
  callback.request = async url => {
    let requestId;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Stream fixture did not close')), 2000);
      const request = http.get(url + '/stream/' + secret, response => {
        requestId = response.headers['x-request-id'];
        response.once('data', () => { if (!failAfterHeaders) { response.destroy(); request.destroy(); } });
        response.once('close', () => setImmediate(() => { clearTimeout(timer); resolve(); }));
      });
      request.on('error', reject);
    });
    // Server-side close is asynchronous to the client's socket close.
    for (let attempt = 0; attempt < 20 && !entries.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const entry = report({ headers: new Headers({ 'x-request-id': requestId }) }, 'request_aborted');
    assert.equal(entry.status, 200);
    assert.equal(entry.route, '/stream/:privateId');
    assert.equal(entry.errorCategory, failAfterHeaders ? 'type_error' : 'unclassified');
  };
  await fixture(callback);
});

test('logging failures do not change the HTTP response or crash the request', async () => {
  const callback = fixtureApp => { fixtureApp.get('/error', (_req, _res, next) => next(new Error(secret))); };
  callback.request = async url => {
    console.error = () => { throw new Error('Fixture log sink unavailable'); };
    const response = await fetch(url + '/error');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
  };
  await fixture(callback);
});
