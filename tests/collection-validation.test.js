const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-collection-validation-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
let server;
let baseUrl;
let user;
let token;

async function request(url, body, method = 'POST', headers = {}) {
  const response = await fetch(baseUrl + url, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json(), collectionVersion: response.headers.get('X-Collection-Version') };
}

test.before(async () => {
  user = await prisma.user.create({ data: { email: 'collections@example.test', passwordHash: 'unused' } });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  await prisma.catalogTab.createMany({ data: Array.from({ length: 6 }, (_,index) => ({
    artist: 'Test Artist', title: `Test_Song_${index}`, format: 'gp5', filePath: `test-${index}.gp5`
  })) });
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

const collections = [
  { route: 'playlists', model: 'playlist', field: 'songCloudIds', data: { songCloudIds: [] } },
  { route: 'karaoke-playlists', model: 'karaokePlaylist', field: 'karaokeCloudIds', data: { karaokeCloudIds: [] } },
  { route: 'chords', model: 'customChord', data: { root: 'C', frets: [0], fingers: [0], baseFret: 1 } }
];

for (const collection of collections) {
  test(`${collection.route} reject invalid metadata without replacing any part of the collection`, async () => {
    const endpoint = '/api/' + collection.route;
    const first = { id: crypto.randomUUID(), name: 'One', ...collection.data, createdAt: 0 };
    const second = { id: crypto.randomUUID(), name: 'Two', ...collection.data };
    const empty = await request(endpoint, undefined, 'GET');
    assert.equal((await request(endpoint + '/sync', [first, second], 'POST', {
      'X-Collection-Version': empty.collectionVersion
    })).status, 200);
    const current = await request(endpoint, undefined, 'GET');
    const before = await prisma[collection.model].findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    const events = await prisma.syncChange.count({ where: { userId: user.id } });
    const cases = collection.field
      ? [{ isPublic: {} }, { createdAt: true }, { createdAt: 'invalid' }, { createdAt: '1e3' }, { [collection.field]: null }, { [collection.field]: 0 }]
      : [{ isPublic: {} }, { root: {} }, { baseFret: true }, { baseFret: null }, { frets: {} }, { fingers: null }, { barres: true }];
    for (const fields of cases) {
      const result = await request(endpoint + '/sync', [
        { ...current.body.find(item => item.id === first.id), name: 'Would change' },
        { id: crypto.randomUUID(), name: 'Invalid replacement', ...collection.data, ...fields }
      ], 'POST', { 'X-Collection-Version': current.collectionVersion });
      assert.equal(result.status, 400, JSON.stringify(fields));
      assert.deepEqual(await prisma[collection.model].findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }), before);
      assert.equal(await prisma.syncChange.count({ where: { userId: user.id } }), events);
      assert.equal((await request(endpoint, undefined, 'GET')).collectionVersion, current.collectionVersion);
    }
    if (collection.field) assert.equal(before.find(item => item.id === first.id).createdAt, 0n);
  });
}

test('catalog rejects invalid pagination and repeated query parameters with 400', async () => {
  for (const query of [
    '?page=-1', '?page=0', '?page=1.5', '?page=1e3', '?page=2text', '?page=', '?page=2147483648',
    '?limit=-1', '?limit=0', '?limit=1.5', '?limit=201', '?limit=999999999999999999',
    '?page=2147483647&limit=200', '?page=1&page=2', '?limit=1&limit=2', '?q=one&q=two'
  ]) {
    const result = await request('/api/catalog/search' + query, undefined, 'GET');
    assert.equal(result.status, 400, query);
    assert.equal(result.body.code, 'validation_error');
  }
});

test('catalog keeps defaults, ordered pages and underscore matching compatible', async () => {
  const defaults = await request('/api/catalog/search', undefined, 'GET');
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.page, 1);
  assert.equal(defaults.body.total, 6);
  assert.equal(defaults.body.tabs.length, 6);
  const first = await request('/api/catalog/search?q=Test%20Song&page=1&limit=2', undefined, 'GET');
  const second = await request('/api/catalog/search?q=Test%20Song&page=2&limit=2', undefined, 'GET');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.totalPages, 3);
  assert.equal(first.body.total, 6);
  assert.equal(first.body.tabs.length, 2);
  assert.equal(second.body.tabs.length, 2);
  assert.equal(new Set([...first.body.tabs, ...second.body.tabs].map(item => item.id)).size, 4);
  const beyond = await request('/api/catalog/search?page=5&limit=2', undefined, 'GET');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.tabs, []);
});

