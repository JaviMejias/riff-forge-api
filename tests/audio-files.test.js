const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-audio-files-');
const limit = 50 * 1024 * 1024;
const sourceUrl = '/uploads/source.mp3';
const sourcePath = path.join(process.env.UPLOAD_DIR, 'source.mp3');
const externalPath = path.join(environment.testDir, 'external.mp3');
let outputMode = 2000;
let downloadMode = 2000;
let ffmpegCalls;
let downloadCalls;
let user;
let token;
let server;
let baseUrl;

function output(filename, mode) {
  if (mode === 'missing') return;
  if (mode === 'symlink') return fs.symlinkSync(externalPath, filename);
  const descriptor = fs.openSync(filename, 'w');
  try { fs.ftruncateSync(descriptor, mode); } finally { fs.closeSync(descriptor); }
}

test.mock.method(childProcess, 'execFile', (binary, args, options, callback) => {
  assert.equal(binary, 'ffmpeg');
  assert.notEqual(options.shell, true);
  ffmpegCalls.push({ args, options });
  output(args.at(-1), outputMode);
  setImmediate(() => callback(null, '', ''));
});

test.mock.method(require('youtube-dl-exec'), 'exec', async (url, flags) => {
  downloadCalls.push({ url, flags });
  if (flags.output) output(flags.output, downloadMode);
  return { exitCode: 0, stdout: JSON.stringify({ title: 'Fixture video' }), stderr: '' };
});

const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { safeUploadPath } = environment.load('services/fileMetadata');

async function request(endpoint, body) {
  const response = await fetch(baseUrl + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

const pitch = (shift = 1) => request('/api/karaokes/process-pitch', { cloudUrl: sourceUrl, pitchShift: shift });
const metadata = () => request('/api/karaokes/youtube-metadata?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'));
const download = endpoint => request(endpoint, { url: 'https://youtu.be/dQw4w9WgXcQ' });
const cacheUrl = (shift = 1) => '/uploads/pitch-' + crypto.createHash('sha256').update(sourceUrl).update(':').update(String(shift)).digest('hex') + '.mp3';

async function assertNoPublication() {
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), ['source.mp3']);
  assert.deepEqual((await prisma.fileAsset.findMany()).map(asset => asset.cloudUrl), [sourceUrl]);
  assert.equal((await metadata()).status, 200);
}

test.before(async () => {
  user = await prisma.user.create({ data: { email: 'audio-files@example.test', passwordHash: 'unused' } });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.beforeEach(async context => {
  context.mock.method(console, 'error', () => {});
  await prisma.fileAsset.deleteMany();
  for (const name of fs.readdirSync(process.env.UPLOAD_DIR)) {
    const filename = path.join(process.env.UPLOAD_DIR, name);
    assert.equal(path.dirname(filename), process.env.UPLOAD_DIR);
    fs.rmSync(filename, { recursive: true, force: true });
  }
  fs.writeFileSync(sourcePath, Buffer.alloc(2000, 3));
  fs.writeFileSync(externalPath, Buffer.alloc(2000, 4));
  await prisma.fileAsset.create({ data: { cloudUrl: sourceUrl, userId: user.id, createdAt: 1n } });
  outputMode = 2000;
  downloadMode = 2000;
  ffmpegCalls = [];
  downloadCalls = [];
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  test.mock.restoreAll();
  environment.cleanup();
});

for (const kind of ['symlink', 'directory', 'missing']) {
  test(`pitch rejects an owned ${kind} input before launching FFmpeg`, async () => {
    fs.unlinkSync(sourcePath);
    if (kind === 'symlink') fs.symlinkSync(externalPath, sourcePath);
    if (kind === 'directory') fs.mkdirSync(sourcePath);
    assert.equal((await pitch()).status, 404);
    assert.equal(ffmpegCalls.length, 0);
    assert.equal(await prisma.fileAsset.count(), 1);
    assert.deepEqual(fs.readFileSync(externalPath), Buffer.alloc(2000, 4));
    if (kind === 'symlink') assert.equal(fs.lstatSync(sourcePath).isSymbolicLink(), true);
  });
}

test('empty pitch inputs are rejected without modifying the original or reserving capacity', async () => {
  fs.truncateSync(sourcePath, 0);
  assert.equal((await pitch()).status, 400);
  assert.equal(ffmpegCalls.length, 0);
  assert.equal(fs.statSync(sourcePath).size, 0);
  await assertNoPublication();
});

test('oversized pitch inputs are rejected even for pitch zero before native work', async () => {
  fs.truncateSync(sourcePath, limit + 1);
  for (const shift of [0, 1]) assert.equal((await pitch(shift)).status, 413);
  assert.equal(ffmpegCalls.length, 0);
  assert.equal(fs.statSync(sourcePath).size, limit + 1);
  await assertNoPublication();
});

test('foreign oversized files remain forbidden instead of exposing a size validation response', async () => {
  const other = await prisma.user.create({ data: { email: 'foreign-audio-files@example.test', passwordHash: 'unused' } });
  await prisma.fileAsset.update({ where: { cloudUrl: sourceUrl }, data: { userId: other.id } });
  fs.truncateSync(sourcePath, limit + 1);
  assert.equal((await pitch()).status, 404);
  assert.equal(ffmpegCalls.length, 0);
});

for (const kind of ['symlink', 'directory']) {
  test(`pitch rejects an owned ${kind} cache entry without following it or overwriting it`, async () => {
    const filename = safeUploadPath(cacheUrl());
    if (kind === 'symlink') fs.symlinkSync(externalPath, filename);
    else fs.mkdirSync(filename);
    await prisma.fileAsset.create({ data: { cloudUrl: cacheUrl(), userId: user.id, createdAt: 1n } });
    assert.equal((await pitch()).status, 404);
    assert.equal(ffmpegCalls.length, 0);
    assert.equal(await prisma.fileAsset.count(), 2);
    assert.equal(fs.existsSync(filename), true);
    assert.deepEqual(fs.readFileSync(externalPath), Buffer.alloc(2000, 4));
  });
}

test('oversized cached pitch output is not served or automatically deleted', async () => {
  const filename = safeUploadPath(cacheUrl());
  output(filename, limit + 1);
  await prisma.fileAsset.create({ data: { cloudUrl: cacheUrl(), userId: user.id, createdAt: 1n } });
  assert.equal((await pitch()).status, 413);
  assert.equal(ffmpegCalls.length, 0);
  assert.equal(fs.statSync(filename).size, limit + 1);
  assert.equal(await prisma.fileAsset.count(), 2);
});

test('oversized generated pitch output is removed before registration and capacity is released', async () => {
  outputMode = limit + 1;
  assert.equal((await pitch()).status, 413);
  assert.equal(ffmpegCalls.length, 1);
  assert.deepEqual(fs.readFileSync(sourcePath), Buffer.alloc(2000, 3));
  await assertNoPublication();
  outputMode = 2000;
  assert.equal((await pitch()).status, 200);
});

test('pitch output at the exact size boundary remains compatible and reusable', async () => {
  outputMode = limit;
  const first = await pitch();
  assert.equal(first.status, 200);
  assert.equal(first.body.cloudUrl, cacheUrl());
  assert.equal(fs.statSync(safeUploadPath(first.body.cloudUrl)).size, limit);
  assert.equal((await pitch()).body.cloudUrl, first.body.cloudUrl);
  assert.equal(ffmpegCalls.length, 1);
});

test('rejected regeneration preserves an existing short cache and its ownership record', async () => {
  const filename = safeUploadPath(cacheUrl());
  output(filename, 500);
  await prisma.fileAsset.create({ data: { cloudUrl: cacheUrl(), userId: user.id, createdAt: 1n } });
  const files = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const assets = await prisma.fileAsset.findMany({ orderBy: { cloudUrl: 'asc' } });
  const bytes = fs.readFileSync(filename);
  outputMode = limit + 1;
  assert.equal((await pitch()).status, 413);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), files);
  assert.deepEqual(await prisma.fileAsset.findMany({ orderBy: { cloudUrl: 'asc' } }), assets);
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal((await metadata()).status, 200);
});

test('unexpected file inspection errors do not become missing-file responses or start conversion', async context => {
  const original = fs.promises.lstat;
  context.mock.method(fs.promises, 'lstat', async filename => {
    if (filename === sourcePath) throw Object.assign(new Error('Fixture read failure'), { code: 'EACCES' });
    return original(filename);
  });
  const result = await pitch();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Internal Server Error' });
  assert.equal(ffmpegCalls.length, 0);
  await assertNoPublication();
});

test('missing and short successful-process outputs return 502 without creating assets', async () => {
  for (const mode of ['missing', 500]) {
    outputMode = mode;
    assert.equal((await pitch()).status, 502);
    await assertNoPublication();
  }
  assert.equal(ffmpegCalls.length, 2);
});

test('symlink conversion output is unlinked without registering or touching its target', async () => {
  outputMode = 'symlink';
  assert.equal((await pitch()).status, 502);
  await assertNoPublication();
  assert.deepEqual(fs.readFileSync(externalPath), Buffer.alloc(2000, 4));
});

test('both downloader routes reject symlink output without copying its target', async () => {
  downloadMode = 'symlink';
  for (const endpoint of ['/api/karaokes/download-audio', '/api/youtube/extract']) {
    assert.equal((await download(endpoint)).status, 502);
    await assertNoPublication();
    assert.deepEqual(fs.readFileSync(externalPath), Buffer.alloc(2000, 4));
  }
});

test('both downloader routes keep empty and size boundary validation compatible', async () => {
  for (const endpoint of ['/api/karaokes/download-audio', '/api/youtube/extract']) {
    for (const [size, status] of [[0, 502], [limit + 1, 413], [limit, 200]]) {
      downloadMode = size;
      const before = await prisma.fileAsset.count();
      const result = await download(endpoint);
      assert.equal(result.status, status);
      assert.equal(await prisma.fileAsset.count(), before + (status === 200 ? 1 : 0));
      if (status === 200) {
        const cloudUrl = result.body.cloudUrl ?? result.body.url;
        assert.equal(fs.statSync(safeUploadPath(cloudUrl)).size, limit);
      }
      assert.equal((await metadata()).status, 200);
    }
  }
});

test('missing and short regular cache files still regenerate without duplicate registration', async () => {
  const filename = safeUploadPath(cacheUrl());
  await prisma.fileAsset.create({ data: { cloudUrl: cacheUrl(), userId: user.id, createdAt: 1n } });
  for (const kind of ['missing', 'short']) {
    if (kind === 'short') output(filename, 500);
    const response = await pitch();
    assert.equal(response.status, 200);
    assert.equal(response.body.cloudUrl, cacheUrl());
    assert.equal(fs.statSync(filename).size, 2000);
    assert.equal(await prisma.fileAsset.count(), 2);
    fs.unlinkSync(filename);
  }
  assert.equal(ffmpegCalls.length, 2);
});

test('non-empty small and exact-boundary source files remain eligible for conversion', async () => {
  for (const [size, shift] of [[100, 1], [limit, 2]]) {
    fs.truncateSync(sourcePath, size);
    assert.equal((await pitch(shift)).status, 200);
    assert.equal(fs.statSync(sourcePath).size, size);
  }
});
