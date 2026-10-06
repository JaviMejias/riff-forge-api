const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-pagination-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const types = [
  { type: 'song', model: 'song', legacy: 'songs', community: 'songs' },
  { type: 'karaoke', model: 'karaoke', legacy: 'karaokes', community: 'karaokes' },
  { type: 'custom_chord', model: 'customChord', legacy: 'chords', community: 'chords' },
  { type: 'playlist', model: 'playlist', legacy: 'playlists' },
  { type: 'karaoke_playlist', model: 'karaokePlaylist', legacy: 'karaoke-playlists' }
];
let server;
let baseUrl;
let owner;
let stranger;
let ownerToken;
let strangerToken;
const records = new Map();

async function request(url, token = ownerToken, options = {}) {
  const response = await fetch(baseUrl + url, {
    ...options,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function rowData(spec, id, userId, isPublic, deletedAt = null) {
  const common = { id, userId, name: 'Pagination fixture', isPublic, deletedAt, createdAt: 1n, updatedAt: 1n };
  if (spec.type === 'song' || spec.type === 'karaoke') return { ...common, dateAdded: 1n };
  if (spec.type === 'custom_chord') return { ...common, root: 'C', frets: '[0]', fingers: '[0]', baseFret: 1 };
  return { ...common, [spec.type === 'playlist' ? 'songCloudIds' : 'karaokeCloudIds']: '[]' };
}

test.before(async () => {
  owner = await prisma.user.create({ data: { email: 'pagination-owner@example.test', passwordHash: 'unused', name: 'Owner', uiStorage: 'private settings' } });
  stranger = await prisma.user.create({ data: { email: 'pagination-stranger@example.test', passwordHash: 'unused', name: 'Stranger' } });
  ownerToken = jwt.sign({ userId: owner.id }, process.env.JWT_SECRET);
  strangerToken = jwt.sign({ userId: stranger.id }, process.env.JWT_SECRET);
  for (const spec of types) {
    const ids = Array.from({ length: 57 }, () => crypto.randomUUID());
    const foreignIds = [crypto.randomUUID(), crypto.randomUUID()];
    const data = ids.map((id, index) => rowData(spec, id, owner.id, index !== 55, index === 56 ? 2n : null));
    data.push(rowData(spec, foreignIds[0], stranger.id, true), rowData(spec, foreignIds[1], stranger.id, false));
    await prisma[spec.model].createMany({ data });
    records.set(spec.type, { own: ids.slice(0, 56).sort(), foreign: [...foreignIds].sort(), public: [...ids.slice(0, 55), foreignIds[0]].sort(), deleted: ids[56] });
  }
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

for (const spec of types) {
  test(`${spec.type} private pages contain only active owner records in deterministic order`, async () => {
    const first = await request('/api/library/' + spec.type);
    assert.equal(first.status, 200);
    assert.equal(first.body.page, 1);
    assert.equal(first.body.limit, 50);
    assert.equal(first.body.items.length, 50);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.nextPage, 2);
    const second = await request('/api/library/' + spec.type + '?page=2');
    assert.equal(second.status, 200);
    assert.equal(second.body.items.length, 6);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextPage, null);
    const all = [...first.body.items, ...second.body.items];
    assert.deepEqual(all.map(item => item.entityId), records.get(spec.type).own);
    assert.ok(all.every(item => item.entityType === spec.type && item.deletedAt === null));
    const foreign = await request('/api/library/' + spec.type, strangerToken);
    assert.deepEqual(foreign.body.items.map(item => item.entityId), records.get(spec.type).foreign);
    assert.equal((await request('/api/library/' + spec.type, null)).status, 401);
    assert.equal(first.headers.get('X-Collection-Version'), null);
    assert.match(first.headers.get('cache-control'), /private.*no-store/);
    assert.match(first.headers.get('vary'), /Authorization/i);
    assert.equal(await prisma.syncChange.count(), 0);
    assert.equal(await prisma.processedSyncOperation.count(), 0);
  });

  test(`${spec.type} legacy full-list responses are not silently truncated`, async () => {
    const response = await request('/api/' + spec.legacy);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.equal(response.body.length, 56);
  });
}

for (const spec of types.filter(item => item.community)) {
  test(`community ${spec.community} supports a second page while preserving its array response`, async () => {
    const first = await request('/api/community/' + spec.community + '?limit=5');
    assert.equal(first.status, 200);
    assert.ok(Array.isArray(first.body));
    assert.equal(first.body.length, 5);
    assert.equal(first.headers.get('X-Has-More'), 'true');
    assert.equal(first.headers.get('X-Next-Page'), '2');
    assert.deepEqual(first.body.map(item => item.id), records.get(spec.type).public.slice(0, 5));
    const second = await request('/api/community/' + spec.community + '?page=2&limit=5');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.map(item => item.id), records.get(spec.type).public.slice(5, 10));
    const defaultPage = await request('/api/community/' + spec.community + '?t=12345');
    assert.equal(defaultPage.body.length, 50);
    const finalPage = await request('/api/community/' + spec.community + '?page=2');
    assert.equal(finalPage.body.length, 6);
    assert.equal(finalPage.headers.get('X-Has-More'), 'false');
    assert.equal(finalPage.headers.get('X-Next-Page'), '');
    const all = [...defaultPage.body, ...finalPage.body];
    assert.deepEqual(all.map(item => item.id), records.get(spec.type).public);
    assert.ok(all.every(item => item.isPublic && item.deletedAt === null && !('email' in item.user) && !('passwordHash' in item.user)));
    assert.equal((await request('/api/community/' + spec.community, null)).status, 401);
  });
}

test('all paginated endpoints reject invalid limits and repeated parameters with 400', async () => {
  const urls = [...types.map(item => '/api/library/' + item.type), ...types.filter(item => item.community).map(item => '/api/community/' + item.community)];
  for (const url of urls) {
    for (const query of ['?page=-1', '?limit=201', '?page=1&page=2', '?limit=1&limit=2']) {
      const result = await request(url + query);
      assert.equal(result.status, 400, url + query);
      assert.equal(result.body.code, 'validation_error');
    }
  }
  for (const query of ['?page=0', '?page=1.5', '?page=1e2', '?limit=', '?limit=0', '?limit=1.5', '?page=2147483647&limit=200']) {
    assert.equal((await request('/api/library/song' + query)).status, 400, query);
  }
});

test('library pages validate entity types, boundaries and file metadata without exposing account fields', async () => {
  assert.equal((await request('/api/library/unknown')).status, 404);
  const result = await request('/api/library/song?limit=200');
  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 56);
  assert.equal(result.body.hasMore, false);
  assert.equal(result.body.nextPage, null);
  assert.ok(result.body.items.every(item => !('userId' in item) && !('passwordHash' in item) && item.data.file === null));
  const beyond = await request('/api/library/song?page=10&limit=50');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.nextPage, null);
  const exactLastPage = await request('/api/library/song?page=2&limit=28');
  assert.equal(exactLastPage.body.items.length, 28);
  assert.equal(exactLastPage.body.hasMore, false);
  assert.equal(exactLastPage.body.nextPage, null);
});

test('pagination parsing rejects structured and unsafe input before querying the database', () => {
  const { parsePagination, pageResult } = environment.load('services/pagination');
  assert.deepEqual(parsePagination({}), { page: 1, limit: 50, skip: 0 });
  assert.deepEqual(parsePagination({ page: '2', limit: '200' }), { page: 2, limit: 200, skip: 200 });
  for (const field of ['page', 'limit']) {
    for (const value of [null, 1, true, {}, ['1'], '01', ' 1', '9007199254740992', '2147483648']) {
      assert.throws(() => parsePagination({ [field]: value }), error => error.status === 400 && error.details.field === field);
    }
  }
  assert.deepEqual(pageResult([], parsePagination({})), { items: [], page: 1, limit: 50, hasMore: false, nextPage: null });
});

test('a partial library page cannot authorize destructive whole-collection replacement', async () => {
  const page = await request('/api/library/playlist?limit=1');
  assert.equal(page.status, 200);
  const items = page.body.items.map(item => ({ id: item.entityId, name: item.data.name, songCloudIds: item.data.songCloudIds, version: item.version }));
  const response = await request('/api/playlists/sync', ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items)
  });
  assert.equal(response.status, 428);
  assert.equal(response.body.code, 'collection_version_required');
  assert.equal(await prisma.playlist.count({ where: { userId: owner.id, deletedAt: null } }), 56);
  assert.equal(await prisma.syncChange.count(), 0);
});

test('community pagination headers remain readable by a cross-origin frontend', async () => {
  const response = await request('/api/community/songs?limit=1', ownerToken, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(response.status, 200);
  const exposed = response.headers.get('Access-Control-Expose-Headers').split(',').map(value => value.trim().toLowerCase());
  assert.ok(exposed.includes('x-has-more'));
  assert.ok(exposed.includes('x-next-page'));
  assert.ok(exposed.includes('etag'));
  assert.ok(exposed.includes('x-collection-version'));
});
