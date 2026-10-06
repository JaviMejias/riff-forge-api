const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-validation-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
let server;
let baseUrl;
let user;
let token;

async function request(url, body, method = 'POST') {
  const response = await fetch(baseUrl + url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

const operation = (entityType, data, overrides = {}) => ({
  operationId: crypto.randomUUID(), entityId: crypto.randomUUID(), entityType,
  action: 'upsert', baseVersion: 0, data, ...overrides
});
const sync = operations => request('/api/sync/v2', { deviceId: crypto.randomUUID(), operations });

test.before(async () => {
  user = await prisma.user.create({ data: {
    email: 'validation@example.test', passwordHash: await bcrypt.hash('ValidPassword1', 10),
    uiStorage: JSON.stringify({ 'ui-storage': 'original' })
  } });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

for (const route of ['songs', 'karaokes']) {
  const model = route === 'songs' ? 'song' : 'karaoke';
  test(`${route} reject invalid metadata before creating rows or sync events`, async () => {
    const before = await prisma[model].count();
    const events = await prisma.syncChange.count();
    for (const fields of [
      { dateAdded: true }, { dateAdded: null }, { dateAdded: '' }, { dateAdded: 1.5 },
      { dateAdded: 'invalid' }, { dateAdded: '1e3' }, { dateAdded: -1 }, { dateAdded: 8640000000000001 },
      { artist: {} }, { textContent: [] }, { isPublic: 'yes' },
      ...(route === 'songs' ? [{ type: 'unknown' }, { capo: 2 }] : [{ hasLocalAudio: 1 }, { pitchShift: 25 }])
    ]) {
      const result = await request('/api/' + route, { name: 'Invalid', ...fields });
      assert.equal(result.status, 400, JSON.stringify(fields));
      assert.equal(result.body.code, 'validation_error');
    }
    assert.equal(await prisma[model].count(), before);
    assert.equal(await prisma.syncChange.count(), events);
  });

  test(`${route} invalid partial edits preserve the row, version and event count`, async () => {
    const created = await request('/api/' + route, { name: 'Original', artist: 'Artist' });
    assert.equal(created.status, 200);
    const before = await prisma[model].findUnique({ where: { id: created.body.id } });
    const events = await prisma.syncChange.count();
    for (const fields of [{ name: '' }, { name: '  ' }, { name: null }, { artist: [] }, { dateAdded: true }, { isPublic: {} }]) {
      const result = await request('/api/' + route + '/' + before.id, { baseVersion: 1, ...fields }, 'PUT');
      assert.equal(result.status, 400, JSON.stringify(fields));
    }
    assert.deepEqual(await prisma[model].findUnique({ where: { id: before.id } }), before);
    assert.equal(await prisma.syncChange.count(), events);
  });

  test(`${route} reject and remove staged multipart files with invalid metadata`, async () => {
    const files = fs.readdirSync(process.env.UPLOAD_DIR).sort();
    const assets = await prisma.fileAsset.count();
    const events = await prisma.syncChange.count();
    const form = new FormData();
    form.set('name', 'Invalid file');
    form.set('dateAdded', '1.5');
    form.set('file', new Blob(['temporary bytes']), route === 'songs' ? 'invalid.gp' : 'invalid.mp3');
    const result = await request('/api/' + route, form);
    assert.equal(result.status, 400);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), files);
    assert.equal(await prisma.fileAsset.count(), assets);
    assert.equal(await prisma.syncChange.count(), events);
    const created = await request('/api/' + route, { name: 'Original file target' });
    const before = await prisma[model].findUnique({ where: { id: created.body.id } });
    const editEvents = await prisma.syncChange.count();
    form.set('baseVersion', '1');
    assert.equal((await request('/api/' + route + '/' + before.id, form, 'PUT')).status, 400);
    assert.deepEqual(await prisma[model].findUnique({ where: { id: before.id } }), before);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), files);
    assert.equal(await prisma.fileAsset.count(), assets);
    assert.equal(await prisma.syncChange.count(), editEvents);
  });

  test(`${route} keep zero dates, nullable metadata and multipart booleans compatible`, async () => {
    const created = await request('/api/' + route, { name: 'Valid', dateAdded: 0, artist: null, isPublic: false });
    assert.equal(created.status, 200);
    assert.equal(created.body.dateAdded, '0');
    const form = new FormData();
    form.set('baseVersion', '1');
    form.set('dateAdded', '123');
    form.set('isPublic', 'true');
    if (route === 'karaokes') { form.set('hasLocalAudio', 'false'); form.set('pitchShift', '0'); }
    const updated = await request('/api/' + route + '/' + created.body.id, form, 'PUT');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.dateAdded, '123');
    assert.equal(updated.body.artist, null);
    assert.equal(updated.body.isPublic, true);
    if (route === 'karaokes') {
      assert.equal(updated.body.pitchShift, 0);
      assert.equal(updated.body.hasLocalAudio, false);
    }
  });
}

test('signup and login reject malformed credential types instead of returning 500', async () => {
  const before = await prisma.user.count();
  for (const url of ['/api/auth/signup', '/api/auth/login']) {
    for (const body of [
      { email: {}, password: 'ValidPassword1' },
      { email: user.email, password: 12345678 },
      { email: user.email, password: [] },
      { email: user.email, password: true },
      []
    ]) {
      assert.equal((await request(url, body)).status, 400, JSON.stringify(body));
    }
  }
  assert.equal((await request('/api/auth/signup', {
    email: 'new-validation@example.test', password: 'ValidPassword1', name: {}
  })).status, 400);
  assert.equal(await prisma.user.count(), before);
  assert.equal((await request('/api/auth/login', { email: user.email, password: 'ValidPassword1' })).status, 200);
  const signup = await request('/api/auth/signup', {
    email: 'valid-signup@example.test', password: 'ValidPassword1', name: 'Usuario de prueba'
  });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.user.name, 'Usuario de prueba');
  assert.equal(jwt.verify(signup.body.token, process.env.JWT_SECRET).userId, signup.body.user.id);
});

test('settings reject malformed storage and preserve the previous settings', async () => {
  const before = (await prisma.user.findUnique({ where: { id: user.id } })).uiStorage;
  for (const body of [{}, { uiStorage: null }, { uiStorage: [] }, { uiStorage: 'text' }]) {
    assert.equal((await request('/api/auth/settings', body)).status, 400);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).uiStorage, before);
  }
  assert.equal((await request('/api/auth/settings', { uiStorage: { 'ui-storage': 'updated' } })).status, 200);
});

test('sync rejects array UUIDs, unsafe versions and malformed operation envelopes', async () => {
  const before = await prisma.processedSyncOperation.count();
  const deviceId = crypto.randomUUID();
  const badDevice = await request('/api/sync/v2', { deviceId: [deviceId], operations: [] });
  assert.equal(badDevice.status, 400);
  assert.equal(badDevice.body.error, 'invalid_device_id');
  const operations = [
    operation('song', { name: 'Invalid' }, { operationId: [crypto.randomUUID()] }),
    operation('song', { name: 'Invalid' }, { entityId: [crypto.randomUUID()] }),
    operation('song', { name: 'Invalid' }, { baseVersion: 2147483648 }),
    operation('song', { name: 'Invalid' }, { baseVersion: true }),
    operation('song', { name: 'Invalid' }, { clientUpdatedAt: true }),
    operation('song', { name: 'Invalid' }, { clientUpdatedAt: -1 }),
    operation('song', { name: 'Invalid' }, { data: [] }),
    null
  ];
  const result = await sync(operations);
  assert.equal(result.status, 200);
  assert.equal(result.body.acknowledgedOperationIds.length, 0);
  assert.equal(result.body.rejectedOperations.length, operations.length);
  assert.ok(result.body.rejectedOperations.every(item => item.operationId === null || typeof item.operationId === 'string'));
  assert.equal(await prisma.processedSyncOperation.count(), before);
});

test('sync rejects invalid metadata per operation without preventing a valid operation', async () => {
  const invalid = [
    operation('song', { name: '  ' }), operation('song', { name: 'Bad date', dateAdded: true }),
    operation('song', { name: 'Bad date', dateAdded: null }), operation('song', { name: 'Bad date', dateAdded: '1e3' }),
    operation('karaoke', { name: 'Bad pitch', pitchShift: 25 }),
    operation('karaoke', { name: 'Bad flag', hasLocalAudio: 'false' }),
    operation('playlist', { name: '', songCloudIds: [] })
  ];
  const valid = operation('song', { name: 'Valid', dateAdded: 0, artist: null, isPublic: false });
  const result = await sync([...invalid, valid]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.acknowledgedOperationIds, [valid.operationId]);
  assert.equal(result.body.rejectedOperations.length, invalid.length);
  assert.ok(result.body.rejectedOperations.every(item => item.reason === 'validation_error' && item.serverEntity === null));
  assert.equal((await prisma.song.findUnique({ where: { id: valid.entityId } })).dateAdded, 0n);
  for (const item of invalid) {
    assert.equal(await prisma.syncChange.count({ where: { entityId: item.entityId } }), 0);
  }
});

test('sync invalid edits do not advance the entity version or add a change', async () => {
  const created = operation('karaoke', { name: 'Original', pitchShift: 0 });
  assert.equal((await sync([created])).body.rejectedOperations.length, 0);
  const before = await prisma.karaoke.findUnique({ where: { id: created.entityId } });
  const events = await prisma.syncChange.count();
  const result = await sync([operation('karaoke', { name: '', pitchShift: 99 }, {
    entityId: created.entityId, baseVersion: 1
  })]);
  assert.equal(result.body.rejectedOperations[0].reason, 'validation_error');
  assert.deepEqual(await prisma.karaoke.findUnique({ where: { id: before.id } }), before);
  assert.equal(await prisma.syncChange.count(), events);
});

test('sync rejects malformed custom chord field types without aborting valid operations', async () => {
  const data = { name: 'C', root: 'C', frets: [0], fingers: [0], baseFret: 1 };
  const invalid = [
    { root: {} }, { root: '' }, { frets: {} }, { fingers: null }, { barres: true },
    { baseFret: true }, { baseFret: null }, { baseFret: 2147483648 }
  ].map(fields => operation('custom_chord', { ...data, ...fields }));
  const valid = operation('custom_chord', { ...data, baseFret: '1' });
  const result = await sync([...invalid, valid]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.acknowledgedOperationIds, [valid.operationId]);
  assert.equal(result.body.rejectedOperations.length, invalid.length);
  assert.equal((await prisma.customChord.findUnique({ where: { id: valid.entityId } })).baseFret, 1);
});

for (const action of ['create', 'update']) {
  test(`sync unexpected database failures roll back ${action}s, events and operation receipts`, async () => {
    const existing = action === 'update' ? operation('song', { name: 'Original before failure' }) : null;
    if (existing) assert.equal((await sync([existing])).body.rejectedOperations.length, 0);
    const original = existing ? await prisma.song.findUnique({ where: { id: existing.entityId } }) : null;
    const before = {
      songs: await prisma.song.count(),
      events: await prisma.syncChange.count(),
      receipts: await prisma.processedSyncOperation.count()
    };
    const first = operation('song', { name: 'Before internal failure' });
    const failing = operation('song', { name: 'Internal failure' }, existing ? { entityId: existing.entityId, baseVersion: 1 } : {});
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_validation_sync_change BEFORE INSERT ON "SyncChange"
      WHEN NEW."entityId" = '${failing.entityId}'
      BEGIN SELECT RAISE(FAIL, 'simulated_sync_change_failure'); END`);
    const log = console.error;
    let logged = false;
    console.error = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('{')) {
        const entry = JSON.parse(args[0]);
        if (entry.event === 'request_failed' && entry.status === 500 && entry.scope === '/api/sync') logged = true;
      } else log(...args);
    };
    try {
      const result = await sync([first, failing]);
      assert.equal(result.status, 500);
      assert.equal(result.body.error, 'sync_failed');
      assert.equal(logged, true);
      assert.equal(await prisma.song.count(), before.songs);
      assert.equal(await prisma.syncChange.count(), before.events);
      assert.equal(await prisma.processedSyncOperation.count(), before.receipts);
      if (original) assert.deepEqual(await prisma.song.findUnique({ where: { id: original.id } }), original);
    } finally {
      console.error = log;
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_validation_sync_change');
    }
  });
}
