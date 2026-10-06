const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-conflicts-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { updateVersioned } = environment.load('services/versionedWrites');
let server;
let baseUrl;

async function request(url, token, body, method = 'POST', headers = {}) {
  const response = await fetch(baseUrl + url, {
    method, headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json(), collectionVersion: response.headers.get('x-collection-version'), etag: response.headers.get('etag') };
}

async function session() {
  const user = await prisma.user.create({ data: { email: crypto.randomUUID() + '@example.test', passwordHash: 'unused' } });
  return { user, token: jwt.sign({ userId: user.id }, process.env.JWT_SECRET) };
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

for (const [route, model, entityType] of [['songs', 'song', 'song'], ['karaokes', 'karaoke', 'karaoke']]) {
  test(`${entityType} metadata requires a valid version and stale edits return the current snapshot`, async () => {
    const { token } = await session();
    const created = await request('/api/' + route, token, { name: 'Original' });
    const url = '/api/' + route + '/' + created.body.id;
    const events = await prisma.syncChange.count();
    assert.equal((await request(url, token, { name: 'Missing' }, 'PUT')).status, 428);
    for (const baseVersion of [null, true, {}, [], 0, -1, 1.5, '1e0', ' 1', '0x1', 2147483648]) {
      const result = await request(url, token, { name: 'Invalid', baseVersion }, 'PUT');
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'invalid_version');
    }
    assert.equal(await prisma.syncChange.count(), events);
    const changed = await request(url, token, { name: 'Winner', baseVersion: 1 }, 'PUT');
    assert.equal(changed.status, 200);
    assert.equal(changed.body.version, 2);
    const stale = await request(url, token, { name: 'Loser', baseVersion: 1 }, 'PUT');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
    assert.equal(stale.body.serverEntity.entityType, entityType);
    assert.equal(stale.body.serverEntity.version, 2);
    assert.equal(stale.body.serverEntity.data.name, 'Winner');
    assert.equal((await prisma[model].findUnique({ where: { id: created.body.id } })).name, 'Winner');
    assert.equal(await prisma.syncChange.count(), events + 1);
  });

  test(`${entityType} delete rejects stale versions and tombstones cannot be restored by legacy PUT`, async () => {
    const { token } = await session();
    const created = await request('/api/' + route, token, { name: 'Delete test' });
    const url = '/api/' + route + '/' + created.body.id;
    await request(url, token, { name: 'Edited', version: 1 }, 'PUT');
    assert.equal((await request(url, token, undefined, 'DELETE')).status, 428);
    assert.equal((await request(url, token, { baseVersion: 1 }, 'DELETE')).status, 409);
    const deleted = await request(url, token, undefined, 'DELETE', { 'If-Match': '"2"' });
    assert.equal(deleted.status, 200);
    const stale = await request(url, token, { name: 'Restore', baseVersion: 3 }, 'PUT');
    assert.equal(stale.status, 409);
    assert.ok(stale.body.serverEntity.deletedAt);
    assert.equal(stale.body.serverEntity.version, 3);
  });

  test(`${entityType} version headers and multipart versions are validated without leaking foreign records`, async () => {
    const owner = await session();
    const stranger = await session();
    const created = await request('/api/' + route, owner.token, { name: 'Private' });
    const url = '/api/' + route + '/' + created.body.id;
    const foreign = await request(url, stranger.token, { name: 'Attack', baseVersion: 1 }, 'PUT');
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.serverEntity, undefined);
    assert.equal((await request(url, owner.token, { name: 'Bad', baseVersion: 1, version: 2 }, 'PUT')).status, 400);
    assert.equal((await request(url, owner.token, { name: 'Bad' }, 'PUT', { 'If-Match': '*' })).status, 400);
    const form = new FormData();
    form.set('name', 'Multipart');
    form.set('baseVersion', '1');
    const updated = await request(url, owner.token, form, 'PUT');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    const header = await request(url, owner.token, { name: 'Header version' }, 'PUT', { 'If-Match': '"2"' });
    assert.equal(header.status, 200);
    assert.equal(header.body.version, 3);
  });

  test(`${entityType} stale file replacement cleans up the staged upload and preserves file metadata`, async () => {
    const { token } = await session();
    const created = await request('/api/' + route, token, { name: 'Original' });
    const url = '/api/' + route + '/' + created.body.id;
    await request(url, token, { name: 'New metadata', baseVersion: 1 }, 'PUT');
    const before = fs.existsSync(process.env.UPLOAD_DIR) ? fs.readdirSync(process.env.UPLOAD_DIR).sort() : [];
    const form = new FormData();
    form.set('baseVersion', '1');
    form.set('file', new Blob(['file contents']), route === 'songs' ? 'song.gp5' : 'karaoke.mp3');
    const rejected = await request(url, token, form, 'PUT');
    assert.equal(rejected.status, 409);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), before);
    const unchanged = await prisma[model].findUnique({ where: { id: created.body.id } });
    assert.equal(unchanged.fileVersion, 0);
    assert.equal(unchanged.cloudUrl, null);
  });

  test(`${entityType} file-only uploads require a known version just like metadata edits`, async () => {
    const { token } = await session();
    const created = await request('/api/' + route, token, { name: 'Original' });
    const url = '/api/' + route + '/' + created.body.id;
    const form = new FormData();
    form.set('id', created.body.id);
    form.set('file', new Blob(['current file']), route === 'songs' ? 'song.gp' : 'karaoke.mp3');
    assert.equal((await request(url, token, form, 'PUT')).status, 428);
    form.set('baseVersion', '1');
    const result = await request(url, token, form, 'PUT');
    assert.equal(result.status, 200);
    assert.equal(result.body.name, 'Original');
    assert.equal(result.body.version, 2);
    assert.equal(result.body.fileVersion, 1);
    const metadata = new FormData();
    metadata.set('name', 'Overwrite metadata');
    metadata.set('file', new Blob(['stale file']), route === 'songs' ? 'song.gp' : 'karaoke.mp3');
    assert.equal((await request(url, token, metadata, 'PUT')).status, 428);
    assert.equal((await prisma[model].findUnique({ where: { id: created.body.id } })).name, 'Original');
  });
}

test('conditional write rejects a stale database snapshot even when its caller forgot to validate a client version', async () => {
  const { token } = await session();
  const created = await request('/api/songs', token, { name: 'Original' });
  const stale = await prisma.song.findUnique({ where: { id: created.body.id } });
  await request('/api/songs/' + stale.id, token, { name: 'Winner', baseVersion: 1 }, 'PUT');
  await assert.rejects(prisma.$transaction(tx => updateVersioned(tx, 'song', stale, { name: 'Loser' })), error => {
    assert.equal(error.status, 409);
    assert.equal(error.details.serverEntity.data.name, 'Winner');
    return true;
  });
  assert.equal((await prisma.song.findUnique({ where: { id: stale.id } })).version, 2);
});

const collections = [
  { route: 'playlists', model: 'playlist', type: 'playlist', data: { songCloudIds: [] } },
  { route: 'karaoke-playlists', model: 'karaokePlaylist', type: 'karaoke_playlist', data: { karaokeCloudIds: [] } },
  { route: 'chords', model: 'customChord', type: 'custom_chord', data: { root: 'C', frets: [0], fingers: [0], baseFret: 1 } }
];

for (const collection of collections) {
  test(`${collection.type} collection snapshot prevents stale omissions from deleting another device's additions`, async () => {
    const { token, user } = await session();
    const endpoint = '/api/' + collection.route;
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const empty = await request(endpoint, token, undefined, 'GET');
    assert.match(empty.collectionVersion, /^"[a-f0-9]{64}"$/);
    assert.equal((await request(endpoint + '/sync', token, [{ id: firstId, name: 'One', ...collection.data }])).status, 428);
    const created = await request(endpoint + '/sync', token, [{ id: firstId, name: 'One', ...collection.data }], 'POST', { 'X-Collection-Version': empty.collectionVersion });
    assert.equal(created.status, 200);
    assert.notEqual(created.collectionVersion, empty.collectionVersion);
    const oldSnapshot = await request(endpoint, token, undefined, 'GET');
    const otherDevice = await request('/api/sync/v2', token, {
      deviceId: crypto.randomUUID(), cursor: null,
      operations: [{ operationId: crypto.randomUUID(), entityId: secondId, entityType: collection.type, action: 'upsert', baseVersion: 0, data: { name: 'Other device', ...collection.data } }]
    });
    assert.equal(otherDevice.body.rejectedOperations.length, 0);
    const before = await prisma.syncChange.count({ where: { userId: user.id } });
    const stale = await request(endpoint + '/sync', token, oldSnapshot.body, 'POST', { 'X-Collection-Version': oldSnapshot.collectionVersion });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'collection_conflict');
    assert.equal(await prisma[collection.model].count({ where: { userId: user.id, deletedAt: null } }), 2);
    assert.equal(await prisma.syncChange.count({ where: { userId: user.id } }), before);
    const current = await request(endpoint, token, undefined, 'GET');
    const replaced = await request(endpoint + '/sync', token, [{ ...current.body.find(item => item.id === firstId), name: 'Renamed' }], 'POST', { 'X-Collection-Version': current.collectionVersion });
    assert.equal(replaced.status, 200);
    assert.equal((await prisma[collection.model].findUnique({ where: { id: firstId } })).version, 2);
    const deleted = await prisma[collection.model].findUnique({ where: { id: secondId } });
    assert.equal(deleted.version, 2);
    assert.ok(deleted.deletedAt);
    const snapshot = JSON.parse((await prisma.syncChange.findFirst({ where: { entityId: secondId }, orderBy: { sequence: 'desc' } })).payload);
    assert.ok(snapshot.deletedAt);
  });

  test(`${collection.type} collection validates duplicate IDs, per-item versions and user-scoped snapshots`, async () => {
    const { token } = await session();
    const stranger = await session();
    const endpoint = '/api/' + collection.route;
    const id = crypto.randomUUID();
    const empty = await request(endpoint, token, undefined, 'GET');
    await request(endpoint + '/sync', token, [{ id, name: 'One', ...collection.data }], 'POST', { 'X-Collection-Version': empty.collectionVersion });
    const current = await request(endpoint, token, undefined, 'GET');
    const oldItem = { ...current.body[0], version: 99 };
    assert.equal((await request(endpoint + '/sync', token, [oldItem], 'POST', { 'X-Collection-Version': current.collectionVersion })).status, 409);
    assert.equal((await request(endpoint + '/sync', token, [current.body[0], current.body[0]], 'POST', { 'X-Collection-Version': current.collectionVersion })).status, 400);
    assert.equal((await request(endpoint + '/sync', stranger.token, [], 'POST', { 'X-Collection-Version': current.collectionVersion })).status, 409);
    const foreignSnapshot = await request(endpoint, stranger.token, undefined, 'GET');
    const foreignId = await request(endpoint + '/sync', stranger.token, [{ id, name: 'Attack', ...collection.data }], 'POST', { 'X-Collection-Version': foreignSnapshot.collectionVersion });
    assert.equal(foreignId.status, 404);
    const deleted = await request(endpoint + '/sync', token, [], 'POST', { 'X-Collection-Version': current.collectionVersion });
    assert.equal(deleted.status, 200);
    assert.notEqual(deleted.collectionVersion, empty.collectionVersion);
    const restored = await request(endpoint + '/sync', token, [{ id, name: 'Restore', ...collection.data }], 'POST', { 'X-Collection-Version': deleted.collectionVersion });
    assert.equal(restored.status, 409);
    assert.ok(restored.body.serverEntity.deletedAt);
  });
}

test('invalid playlist references roll back earlier updates, implicit deletions and sync events', async () => {
  const { token, user } = await session();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  let response = await request('/api/playlists', token, undefined, 'GET');
  await request('/api/playlists/sync', token, [{ id: first, name: 'One', songCloudIds: [] }, { id: second, name: 'Two', songCloudIds: [] }], 'POST', { 'X-Collection-Version': response.collectionVersion });
  response = await request('/api/playlists', token, undefined, 'GET');
  const events = await prisma.syncChange.count({ where: { userId: user.id } });
  const result = await request('/api/playlists/sync', token, [
    { ...response.body.find(item => item.id === first), name: 'Changed' },
    { id: crypto.randomUUID(), name: 'Invalid', songCloudIds: [crypto.randomUUID()] }
  ], 'POST', { 'X-Collection-Version': response.collectionVersion });
  assert.equal(result.status, 400);
  assert.equal((await prisma.playlist.findUnique({ where: { id: first } })).name, 'One');
  assert.equal((await prisma.playlist.findUnique({ where: { id: second } })).deletedAt, null);
  assert.equal(await prisma.syncChange.count({ where: { userId: user.id } }), events);
});

test('audio detachment identifies one karaoke and rejects stale versions without changing another reference', async () => {
  const { token } = await session();
  const form = new FormData();
  form.set('name', 'Audio');
  form.set('file', new Blob(['audio']), 'audio.mp3');
  const first = await request('/api/karaokes', token, form);
  const second = await request('/api/karaokes', token, { name: 'Shared', cloudUrl: first.body.cloudUrl });
  const payload = { cloudUrl: first.body.cloudUrl, baseVersion: 1 };
  assert.equal((await request('/api/karaokes/delete-audio', token, payload)).body.code, 'ambiguous_audio_reference');
  assert.equal((await request('/api/karaokes/delete-audio', token, { id: first.body.id, cloudUrl: first.body.cloudUrl })).status, 428);
  await request('/api/karaokes/' + first.body.id, token, { name: 'Renamed', baseVersion: 1 }, 'PUT');
  assert.equal((await request('/api/karaokes/delete-audio', token, { ...payload, id: first.body.id })).status, 409);
  assert.equal((await request('/api/karaokes/delete-audio', token, { ...payload, id: first.body.id, baseVersion: 2 })).status, 200);
  assert.equal((await prisma.karaoke.findUnique({ where: { id: second.body.id } })).cloudUrl, first.body.cloudUrl);
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(first.body.cloudUrl))));
});

test('parallel legacy edits based on the same version accept only one change', async () => {
  const { token } = await session();
  const created = await request('/api/songs', token, { name: 'Original' });
  const results = await Promise.all(['A', 'B'].map(name => request('/api/songs/' + created.body.id, token, { name, baseVersion: 1 }, 'PUT')));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await prisma.song.findUnique({ where: { id: created.body.id } })).version, 2);
  assert.equal(await prisma.syncChange.count({ where: { entityId: created.body.id, version: 2 } }), 1);
});

test('collection concurrency token does not prevent HTTP cache invalidation when an embedded song changes', async () => {
  const { token } = await session();
  const song = await request('/api/songs', token, { name: 'Original' });
  const empty = await request('/api/playlists', token, undefined, 'GET');
  await request('/api/playlists/sync', token, [{ id: crypto.randomUUID(), name: 'Set', songCloudIds: [song.body.id] }], 'POST', { 'X-Collection-Version': empty.collectionVersion });
  const before = await request('/api/playlists', token, undefined, 'GET');
  await request('/api/songs/' + song.body.id, token, { name: 'Renamed', baseVersion: 1 }, 'PUT');
  const after = await request('/api/playlists', token, undefined, 'GET');
  assert.equal(after.collectionVersion, before.collectionVersion);
  assert.notEqual(after.etag, before.etag);
  assert.equal(after.body[0].songs[0].name, 'Renamed');
});

test('parallel collection replacements accept one snapshot and reject the other without mixing lists', async () => {
  const { token, user } = await session();
  const empty = await request('/api/playlists', token, undefined, 'GET');
  const results = await Promise.all(['A', 'B'].map(name => request('/api/playlists/sync', token, [
    { id: crypto.randomUUID(), name, songCloudIds: [] }
  ], 'POST', { 'X-Collection-Version': empty.collectionVersion })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(await prisma.playlist.count({ where: { userId: user.id, deletedAt: null } }), 1);
  assert.equal(await prisma.syncChange.count({ where: { userId: user.id } }), 1);
});

test('legacy creates reject an existing or tombstoned ID without exposing a foreign owner', async () => {
  const owner = await session();
  const stranger = await session();
  for (const route of ['songs', 'karaokes']) {
    const id = crypto.randomUUID();
    await request('/api/' + route, owner.token, { id, name: 'Original' });
    const duplicate = await request('/api/' + route, owner.token, { id, name: 'Duplicate' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.serverEntity.data.name, 'Original');
    const foreign = await request('/api/' + route, stranger.token, { id, name: 'Attack' });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.serverEntity, undefined);
    await request('/api/' + route + '/' + id, owner.token, { baseVersion: 1 }, 'DELETE');
    const tombstone = await request('/api/' + route, owner.token, { id, name: 'Restore' });
    assert.equal(tombstone.status, 409);
    assert.ok(tombstone.body.serverEntity.deletedAt);
  }
});
