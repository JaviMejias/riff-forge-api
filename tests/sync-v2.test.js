const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-forge-sync-'));
process.env.DATABASE_URL = `file:${path.join(testDir, 'sync.db')}`;
process.env.JWT_SECRET = 'integration-test-secret-with-sufficient-length';
for (const migration of ['20260621012303_init_catalog', '20260810000000_add_sync_v2']) {
  execFileSync('npx', ['prisma', 'db', 'execute', '--url', process.env.DATABASE_URL, '--file', path.join(__dirname, '..', 'prisma', 'migrations', migration, 'migration.sql')], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
}

const { app } = require('../dist/index');
const { prisma } = require('../dist/utils/prisma');
const jwt = require('jsonwebtoken');
let server;
let baseUrl;
let userA;
let userB;
let tokenA;
let tokenB;
let cursor = null;
const deviceA = crypto.randomUUID();
const deviceB = crypto.randomUUID();

async function request(url, token, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...options.headers } });
  const body = await response.json();
  return { status: response.status, body };
}

async function sync(token, deviceId, operations = [], requestedCursor = cursor, limit) {
  const suffix = limit ? `?limit=${limit}` : '';
  return request(`/api/sync/v2${suffix}`, token, { method: 'POST', body: JSON.stringify({ deviceId, cursor: requestedCursor, operations }) });
}

function operation(entityType, entityId, action, baseVersion, data = undefined) {
  return { operationId: crypto.randomUUID(), entityType, entityId, action, baseVersion, data };
}

test.before(async () => {
  userA = await prisma.user.create({ data: { email: 'a@example.test', passwordHash: 'x' } });
  userB = await prisma.user.create({ data: { email: 'b@example.test', passwordHash: 'x' } });
  tokenA = jwt.sign({ userId: userA.id }, process.env.JWT_SECRET);
  tokenB = jwt.sign({ userId: userB.id }, process.env.JWT_SECRET);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('create on one device and download on another, including offline catch-up', async () => {
  const id = crypto.randomUUID();
  const created = await sync(tokenA, deviceA, [operation('song', id, 'upsert', 0, { name: 'Song', artist: 'Artist', textContent: 'v1' })], null);
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.acknowledgedOperationIds.length, 1);
  const downloaded = await sync(tokenA, deviceB, [], null);
  assert.equal(downloaded.body.changes.some(change => change.entityId === id && change.data.textContent === 'v1'), true);
  cursor = downloaded.body.nextCursor;
  global.songId = id;
});

test('edit lyrics and metadata with a server version', async () => {
  const result = await sync(tokenA, deviceA, [operation('song', global.songId, 'upsert', 1, { name: 'Renamed', textContent: 'v2', capo: '2' })]);
  assert.equal(result.body.rejectedOperations.length, 0);
  assert.equal(result.body.changes.at(-1).version, 2);
  assert.equal(result.body.changes.at(-1).data.textContent, 'v2');
  cursor = result.body.nextCursor;
});

test('legacy file replacement increments fileVersion and is synchronized', async () => {
  const form = new FormData();
  form.set('name', 'Renamed');
  form.set('file', new Blob(['guitar-pro-data'], { type: 'application/octet-stream' }), 'song.gp5');
  const updated = await request(`/api/songs/${global.songId}`, tokenA, { method: 'PUT', body: form });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.fileVersion, 1);
  const pulled = await sync(tokenA, deviceB, [], cursor);
  assert.equal(pulled.body.changes[0].data.file.version, 1);
  assert.match(pulled.body.changes[0].data.file.hash, /^[a-f0-9]{64}$/);
  cursor = pulled.body.nextCursor;
});

test('delete propagates a tombstone and stale upsert cannot resurrect it', async () => {
  const deleted = await sync(tokenA, deviceA, [operation('song', global.songId, 'delete', 3)]);
  assert.ok(deleted.body.changes.at(-1).deletedAt);
  const stale = await sync(tokenA, deviceB, [operation('song', global.songId, 'upsert', 2, { name: 'Old' })], deleted.body.nextCursor);
  assert.equal(stale.body.rejectedOperations[0].reason, 'conflict');
  assert.ok(stale.body.rejectedOperations[0].serverEntity.deletedAt);
  cursor = stale.body.nextCursor;
});

test('retrying an operation is idempotent', async () => {
  const chordId = crypto.randomUUID();
  const op = operation('custom_chord', chordId, 'upsert', 0, { name: 'C', root: 'C', frets: [0], fingers: [0], baseFret: 1 });
  const first = await sync(tokenA, deviceA, [op], cursor);
  const second = await sync(tokenA, deviceA, [op], first.body.nextCursor);
  assert.deepEqual(second.body.acknowledgedOperationIds, [op.operationId]);
  assert.equal(await prisma.customChord.count({ where: { id: chordId } }), 1);
  global.chordId = chordId;
  cursor = second.body.nextCursor;
});

test('custom chords can be edited and tombstoned', async () => {
  const edited = await sync(tokenA, deviceA, [operation('custom_chord', global.chordId, 'upsert', 1, { name: 'C major' })], cursor);
  const removed = await sync(tokenA, deviceA, [operation('custom_chord', global.chordId, 'delete', 2)], edited.body.nextCursor);
  assert.ok(removed.body.changes.at(-1).deletedAt);
  cursor = removed.body.nextCursor;
});

test('playlists preserve order, rename, reorder and delete', async () => {
  const first = crypto.randomUUID(); const second = crypto.randomUUID(); const playlist = crypto.randomUUID();
  let result = await sync(tokenA, deviceA, [operation('song', first, 'upsert', 0, { name: '1' }), operation('song', second, 'upsert', 0, { name: '2' })], cursor);
  result = await sync(tokenA, deviceA, [operation('playlist', playlist, 'upsert', 0, { name: 'Set', songCloudIds: [second, first] })], result.body.nextCursor);
  assert.deepEqual(result.body.changes.at(-1).data.songCloudIds, [second, first]);
  result = await sync(tokenA, deviceA, [operation('playlist', playlist, 'upsert', 1, { name: 'Live', songCloudIds: [first, second] })], result.body.nextCursor);
  assert.deepEqual(result.body.changes.at(-1).data.songCloudIds, [first, second]);
  result = await sync(tokenA, deviceA, [operation('playlist', playlist, 'delete', 2)], result.body.nextCursor);
  assert.ok(result.body.changes.at(-1).deletedAt);
  cursor = result.body.nextCursor;
});

test('karaoke playlists use ordered cloud UUIDs', async () => {
  const first = crypto.randomUUID(); const second = crypto.randomUUID(); const playlist = crypto.randomUUID();
  let result = await sync(tokenA, deviceA, [operation('karaoke', first, 'upsert', 0, { name: 'K1' }), operation('karaoke', second, 'upsert', 0, { name: 'K2' })], cursor);
  result = await sync(tokenA, deviceA, [operation('karaoke_playlist', playlist, 'upsert', 0, { name: 'Karaoke set', karaokeCloudIds: [second, first] })], result.body.nextCursor);
  assert.deepEqual(result.body.changes.at(-1).data.karaokeCloudIds, [second, first]);
  result = await sync(tokenA, deviceA, [operation('karaoke_playlist', playlist, 'upsert', 1, { name: 'Reordered', karaokeCloudIds: [first, second] })], result.body.nextCursor);
  assert.deepEqual(result.body.changes.at(-1).data.karaokeCloudIds, [first, second]);
  result = await sync(tokenA, deviceA, [operation('karaoke_playlist', playlist, 'delete', 2)], result.body.nextCursor);
  assert.ok(result.body.changes.at(-1).deletedAt);
  cursor = result.body.nextCursor;
});

test('simultaneous edits return explicit conflict and server state', async () => {
  const id = crypto.randomUUID();
  let result = await sync(tokenA, deviceA, [operation('karaoke', id, 'upsert', 0, { name: 'K' })], cursor);
  result = await sync(tokenA, deviceA, [operation('karaoke', id, 'upsert', 1, { name: 'Winner' })], result.body.nextCursor);
  const loser = await sync(tokenA, deviceB, [operation('karaoke', id, 'upsert', 1, { name: 'Loser' })], result.body.nextCursor);
  assert.equal(loser.body.rejectedOperations[0].reason, 'conflict');
  assert.equal(loser.body.rejectedOperations[0].serverEntity.data.name, 'Winner');
  cursor = loser.body.nextCursor;
});

test('pagination advances only through included immutable change snapshots', async () => {
  const start = cursor;
  for (let i = 0; i < 3; i++) {
    const result = await sync(tokenA, deviceA, [operation('song', crypto.randomUUID(), 'upsert', 0, { name: `Page ${i}` })], cursor);
    cursor = result.body.nextCursor;
  }
  const seen = [];
  let pageCursor = start;
  let hasMore;
  do {
    const page = await sync(tokenA, deviceB, [], pageCursor, 1);
    assert.ok(page.body.changes.length <= 1);
    seen.push(...page.body.changes.map(change => `${change.entityId}:${change.version}`));
    pageCursor = page.body.nextCursor;
    hasMore = page.body.hasMore;
  } while (hasMore);
  assert.equal(new Set(seen).size, seen.length);
});

test('cross-user entity IDs and playlist references are forbidden', async () => {
  const foreignId = crypto.randomUUID();
  await sync(tokenB, deviceB, [operation('song', foreignId, 'upsert', 0, { name: 'Private' })], null);
  const collision = await sync(tokenA, deviceA, [operation('song', foreignId, 'upsert', 0, { name: 'Attack' })], cursor);
  assert.equal(collision.body.rejectedOperations[0].reason, 'forbidden');
  const reference = await sync(tokenA, deviceA, [operation('playlist', crypto.randomUUID(), 'upsert', 0, { name: 'Attack', songCloudIds: [foreignId] })], cursor);
  assert.equal(reference.body.rejectedOperations[0].reason, 'forbidden');
});

test('legacy endpoints remain visible to sync clients', async () => {
  const id = crypto.randomUUID();
  const created = await request('/api/songs', tokenA, { method: 'POST', body: JSON.stringify({ id, name: 'Legacy' }) });
  assert.equal(created.status, 200);
  const pulled = await sync(tokenA, deviceB, [], cursor);
  assert.equal(pulled.body.changes.some(change => change.entityId === id), true);
  const list = await request('/api/songs', tokenA);
  assert.equal(list.body.some(song => song.id === id), true);
});

test('a rejected operation does not prevent valid operations from committing', async () => {
  const validId = crypto.randomUUID();
  const result = await sync(tokenA, deviceA, [operation('playlist', crypto.randomUUID(), 'upsert', 0, { name: 'Bad', songCloudIds: [crypto.randomUUID()] }), operation('song', validId, 'upsert', 0, { name: 'Good' })], cursor);
  assert.equal(result.body.rejectedOperations.length, 1);
  assert.equal(result.body.acknowledgedOperationIds.length, 1);
  assert.equal(await prisma.song.count({ where: { id: validId } }), 1);
});
