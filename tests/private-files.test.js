const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');
const environment = createEnvironment('riff-forge-access-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
let server, baseUrl, owner, stranger, ownerToken, strangerToken;

async function get(url, token, headers = {}, method = 'GET') {
  return fetch(baseUrl + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } });
}

async function asset(isPublic = false) {
  const filename = crypto.randomUUID() + '.mp3';
  const cloudUrl = '/uploads/' + filename;
  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, filename), 'private-audio-bytes');
  await prisma.fileAsset.create({ data: { cloudUrl, userId: owner.id, createdAt: 1n } });
  const karaoke = await prisma.karaoke.create({ data: { name: 'Audio', userId: owner.id, cloudUrl, isPublic, dateAdded: 1n, updatedAt: 1n } });
  return { cloudUrl, karaoke, filename };
}

test.before(async () => {
  owner = await prisma.user.create({ data: { email: 'owner@example.test', passwordHash: 'unused' } });
  stranger = await prisma.user.create({ data: { email: 'stranger@example.test', passwordHash: 'unused' } });
  ownerToken = jwt.sign({ userId: owner.id }, process.env.JWT_SECRET);
  strangerToken = jwt.sign({ userId: stranger.id }, process.env.JWT_SECRET);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
});
test.after(async () => {
  if(server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

test('private files are readable only by their owner, never via a query-string JWT', async () => {
  const file = await asset();
  assert.equal((await get(file.cloudUrl)).status, 404);
  assert.equal((await get(file.cloudUrl, strangerToken)).status, 404);
  assert.equal((await get(file.cloudUrl + '?token=' + ownerToken)).status, 404);
  const response = await get(file.cloudUrl, ownerToken);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'private-audio-bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('vary'), /Authorization/);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('active public content is readable anonymously and privacy withdrawal is effective immediately', async () => {
  const file = await asset(true);
  assert.equal((await get(file.cloudUrl)).status, 200);
  assert.equal((await get(file.cloudUrl, strangerToken)).status, 200);
  await prisma.karaoke.update({ where: { id: file.karaoke.id }, data: { isPublic: false } });
  assert.equal((await get(file.cloudUrl)).status, 404);
  assert.equal((await get(file.cloudUrl, strangerToken)).status, 404);
  assert.equal((await get(file.cloudUrl, ownerToken)).status, 200);
});

test('a forged public reference by another user cannot publish the original owner private file', async () => {
  const file = await asset();
  await prisma.karaoke.create({ data: { name: 'Forged', userId: stranger.id, cloudUrl: file.cloudUrl, isPublic: true, dateAdded: 1n, updatedAt: 1n } });
  assert.equal((await get(file.cloudUrl)).status, 404);
  assert.equal((await get(file.cloudUrl, strangerToken)).status, 404);
});

test('unattached registered downloads and retained historical files remain accessible to the owner', async () => {
  const file = await asset(true);
  await prisma.karaoke.delete({ where: { id: file.karaoke.id } });
  assert.equal((await get(file.cloudUrl)).status, 404);
  assert.equal((await get(file.cloudUrl, ownerToken)).status, 200);
});

test('deleted public entities do not make retained files public', async () => {
  const file = await asset(true);
  await prisma.karaoke.update({ where: { id: file.karaoke.id }, data: { deletedAt: 2n } });
  assert.equal((await get(file.cloudUrl)).status, 404);
  assert.equal((await get(file.cloudUrl, ownerToken)).status, 200);
});

test('legacy ownership is resolved without read-time writes and ambiguous ownership is denied', async () => {
  const file = await asset();
  await prisma.fileAsset.delete({ where: { cloudUrl: file.cloudUrl } });
  assert.equal((await get(file.cloudUrl, ownerToken)).status, 200);
  assert.equal(await prisma.fileAsset.count({ where: { cloudUrl: file.cloudUrl } }), 0);
  await prisma.song.create({ data: { name: 'Shared legacy', userId: stranger.id, cloudUrl: file.cloudUrl, isPublic: true, dateAdded: 1n, updatedAt: 1n } });
  for(const token of [undefined, ownerToken, strangerToken]) assert.equal((await get(file.cloudUrl, token)).status, 404);
});

test('HEAD and ranges preserve authorization, including conditional cache requests', async () => {
  const file = await asset();
  const head = await get(file.cloudUrl, ownerToken, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), 19);
  assert.equal(await head.text(), '');
  const ranged = await get(file.cloudUrl, ownerToken, { Range: 'bytes=0-6' });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), 'private');
  assert.equal((await get(file.cloudUrl, strangerToken, { Range: 'bytes=0-6' })).status, 404);
  assert.equal((await get(file.cloudUrl, strangerToken, { 'If-None-Match': head.headers.get('etag') })).status, 404);
  assert.equal((await get(file.cloudUrl, ownerToken, { Range: 'bytes=1000-2000' })).status, 416);
});

test('paths, symlinks, directories and write methods cannot bypass file permissions', async () => {
  assert.equal((await get('/uploads/%2e%2e%2fsecret', ownerToken)).status, 404);
  assert.equal((await get('/uploads/.env', ownerToken)).status, 404);
  const file = await asset();
  fs.unlinkSync(path.join(process.env.UPLOAD_DIR, file.filename));
  const outside = path.join(environment.testDir, 'secret');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(process.env.UPLOAD_DIR, file.filename));
  assert.equal((await get(file.cloudUrl, ownerToken)).status, 404);
  assert.equal((await get(file.cloudUrl, ownerToken, {}, 'POST')).status, 405);
});

test('invalid or malformed JWT claims never authenticate uploads or expose user-scoped API data', async () => {
  const file = await asset(true);
  for(const payload of [{}, { userId: null }, { userId: 1 }, { userId: '' }]) {
    const token = jwt.sign(payload, process.env.JWT_SECRET);
    assert.equal((await get(file.cloudUrl, token)).status, 401);
    assert.equal((await get('/api/songs', token)).status, 401);
  }
  const expired = jwt.sign({ userId: owner.id }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await get(file.cloudUrl, expired)).status, 401);
  const wrongAlgorithm = jwt.sign({ userId: owner.id }, process.env.JWT_SECRET, { algorithm: 'HS512' });
  assert.equal((await get(file.cloudUrl, wrongAlgorithm)).status, 401);
});
