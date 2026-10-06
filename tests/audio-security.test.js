const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-audio-');
const ffmpegCalls = [];
const downloadCalls = [];
let downloadMode = 'normal';
let ffmpegMode = 'normal';
test.mock.method(childProcess, 'execFile', (binary, args, options, callback) => {
  assert.equal(binary, 'ffmpeg');
  assert.notEqual(options.shell, true);
  ffmpegCalls.push({ args, options });
  const filter = args[args.indexOf('-af') + 1];
  if (ffmpegMode === 'timeout' || (ffmpegMode === 'fallback' && filter.startsWith('rubberband='))) {
    const error = Object.assign(new Error('Simulated FFmpeg failure'), { killed: ffmpegMode === 'timeout' });
    setImmediate(() => callback(error));
    return;
  }
  fs.writeFileSync(args.at(-1), Buffer.alloc(2000, 1));
  setImmediate(() => callback(null, '', ''));
});

const youtubedl = require('youtube-dl-exec');
test.mock.method(youtubedl, 'exec', async (url, flags, options) => {
  downloadCalls.push({ url, flags, options });
  if (flags.output && downloadMode !== 'missing') fs.writeFileSync(flags.output, Buffer.alloc(2000, 2));
  if (downloadMode === 'failed') return { exitCode: 1, stdout: '', stderr: 'Simulated downloader failure' };
  return { exitCode: 0, stdout: JSON.stringify({ title: 'Test video' }), stderr: '' };
});

const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { safeUploadPath } = environment.load('services/fileMetadata');
const { normalizeYouTubeUrl, parsePitchShift } = environment.load('services/audioService');
const jwt = require('jsonwebtoken');
let server;
let baseUrl;
let userA;
let userB;
let tokenA;
let tokenB;

async function request(url, token, options = {}) {
  const multipart = options.body instanceof FormData;
  const response = await fetch(baseUrl + url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(multipart ? {} : { 'content-type': 'application/json' }),
      ...options.headers
    }
  });
  return { status: response.status, body: await response.json() };
}

function post(url, token, body) {
  return request(url, token, { method: 'POST', body: JSON.stringify(body) });
}

async function uploadKaraoke(token, attributes = {}, filename = 'song.mp3') {
  const form = new FormData();
  form.set('name', 'Uploaded audio');
  for (const [key, value] of Object.entries(attributes)) form.set(key, String(value));
  form.set('file', new Blob([Buffer.alloc(2000, 3)], { type: 'audio/mpeg' }), filename);
  return request('/api/karaokes', token, { method: 'POST', body: form });
}

test.before(async () => {
  userA = await prisma.user.create({ data: { email: 'audio-a@example.test', passwordHash: 'test' } });
  userB = await prisma.user.create({ data: { email: 'audio-b@example.test', passwordHash: 'test' } });
  tokenA = jwt.sign({ userId: userA.id }, process.env.JWT_SECRET);
  tokenB = jwt.sign({ userId: userB.id }, process.env.JWT_SECRET);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  } finally {
    test.mock.restoreAll();
    environment.cleanup();
  }
});

test('uploads are isolated from the real project directory', () => {
  assert.equal(process.env.UPLOAD_DIR, path.join(environment.testDir, 'uploads'));
  assert.notEqual(process.env.UPLOAD_DIR, path.resolve(__dirname, '../uploads'));
});

test('YouTube URLs are normalized to one video and foreign hosts are rejected', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=ignored',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ'
  ]) {
    assert.equal(normalizeYouTubeUrl(url), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
  for (const url of [
    'http://127.0.0.1/?r=youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:444/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=123',
    'file:///uploads/audio.mp3',
    'https://youtu.be/invalid'
  ]) assert.throws(() => normalizeYouTubeUrl(url), error => error.status === 400);
});

test('all downloader endpoints reject foreign hosts before spawning a process', async () => {
  const before = downloadCalls.length;
  const url = 'http://127.0.0.1/?r=youtube.com/watch?v=dQw4w9WgXcQ';
  assert.equal((await post('/api/karaokes/download-audio', tokenA, { url })).status, 400);
  assert.equal((await post('/api/youtube/extract', tokenA, { url })).status, 400);
  assert.equal((await request('/api/karaokes/youtube-metadata?url=' + encodeURIComponent(url), tokenA)).status, 400);
  assert.equal(downloadCalls.length, before);
});

test('pitch rejects commands, objects, non-finite values and values outside the range', async () => {
  const before = ffmpegCalls.length;
  for (const pitchShift of ['1$(printf injected)', '1;echo injected', {}, null, true, '', 25, -25]) {
    const response = await post('/api/karaokes/process-pitch', tokenA, { cloudUrl: '/uploads/test.mp3', pitchShift });
    assert.equal(response.status, 400);
  }
  assert.throws(() => parsePitchShift(Infinity), error => error.status === 400);
  assert.throws(() => parsePitchShift(NaN), error => error.status === 400);
  assert.equal(parsePitchShift('0'), 0);
  assert.equal(ffmpegCalls.length, before);
});

test('upload path validation rejects traversal and dot directories', () => {
  for (const url of ['/uploads/..', '/uploads/.', '/uploads/../secret', '/uploads/../uploads-evil/audio.mp3', '/uploads/a/b.mp3']) {
    assert.equal(safeUploadPath(url), null);
  }
});

test('multipart upload records an independent file owner', async () => {
  const result = await uploadKaraoke(tokenA);
  assert.equal(result.status, 200);
  const owner = await prisma.fileAsset.findUnique({ where: { cloudUrl: result.body.cloudUrl } });
  assert.equal(owner.userId, userA.id);
  assert.equal(fs.existsSync(safeUploadPath(result.body.cloudUrl)), true);
});

test('a private foreign URL cannot be claimed by creating a karaoke or song', async () => {
  const source = await uploadKaraoke(tokenA);
  for (const endpoint of ['/api/karaokes', '/api/songs']) {
    const result = await post(endpoint, tokenB, { name: 'Attempted claim', cloudUrl: source.body.cloudUrl });
    assert.equal(result.status, 404);
  }
  assert.equal(await prisma.karaoke.count({ where: { userId: userB.id, cloudUrl: source.body.cloudUrl } }), 0);
  assert.equal(fs.existsSync(safeUploadPath(source.body.cloudUrl)), true);
});

test('a forged legacy karaoke does not authorize deleting or processing a foreign file', async () => {
  const source = await uploadKaraoke(tokenA);
  const now = BigInt(Date.now());
  const forged = await prisma.karaoke.create({ data: {
    name: 'Legacy forged reference', userId: userB.id, cloudUrl: source.body.cloudUrl, dateAdded: now, updatedAt: now, isPublic: true
  } });
  const before = ffmpegCalls.length;
  assert.equal((await post('/api/karaokes/delete-audio', tokenB, { cloudUrl: source.body.cloudUrl })).status, 404);
  assert.equal((await post('/api/karaokes/process-pitch', tokenB, { cloudUrl: source.body.cloudUrl, pitchShift: 1 })).status, 404);
  assert.equal((await prisma.karaoke.findUnique({ where: { id: forged.id } })).cloudUrl, source.body.cloudUrl);
  assert.equal(fs.existsSync(safeUploadPath(source.body.cloudUrl)), true);
  assert.equal(ffmpegCalls.length, before);
  assert.equal((await post('/api/karaokes', tokenB, { name: 'Forged public import', cloudUrl: source.body.cloudUrl })).status, 404);
});

test('legacy files can be registered only when their owner is unambiguous', async () => {
  const source = await uploadKaraoke(tokenA);
  await prisma.fileAsset.delete({ where: { cloudUrl: source.body.cloudUrl } });
  const accepted = await post('/api/karaokes/process-pitch', tokenA, { cloudUrl: source.body.cloudUrl, pitchShift: 0 });
  assert.equal(accepted.status, 200);
  assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: source.body.cloudUrl } })).userId, userA.id);

  await prisma.fileAsset.delete({ where: { cloudUrl: source.body.cloudUrl } });
  const now = BigInt(Date.now());
  await prisma.karaoke.create({ data: { name: 'Ambiguous reference', userId: userB.id, cloudUrl: source.body.cloudUrl, dateAdded: now, updatedAt: now, isPublic: true } });
  assert.equal((await post('/api/karaokes/delete-audio', tokenB, { cloudUrl: source.body.cloudUrl })).status, 404);
  assert.equal((await post('/api/karaokes', tokenB, { name: 'Ambiguous import', cloudUrl: source.body.cloudUrl })).status, 404);
  assert.equal(await prisma.fileAsset.count({ where: { cloudUrl: source.body.cloudUrl } }), 0);
  assert.equal(fs.existsSync(safeUploadPath(source.body.cloudUrl)), true);
});

test('public imports receive independent owned copies', async () => {
  const source = await uploadKaraoke(tokenA, { isPublic: true });
  const imported = await post('/api/karaokes', tokenB, { name: 'Imported', cloudUrl: source.body.cloudUrl });
  assert.equal(imported.status, 200);
  assert.notEqual(imported.body.cloudUrl, source.body.cloudUrl);
  const owner = await prisma.fileAsset.findUnique({ where: { cloudUrl: imported.body.cloudUrl } });
  assert.equal(owner.userId, userB.id);
  assert.deepEqual(fs.readFileSync(safeUploadPath(imported.body.cloudUrl)), fs.readFileSync(safeUploadPath(source.body.cloudUrl)));
  assert.equal((await post('/api/karaokes/delete-audio', tokenB, { id: imported.body.id, baseVersion: imported.body.version, cloudUrl: imported.body.cloudUrl })).status, 200);
  assert.equal(fs.existsSync(safeUploadPath(source.body.cloudUrl)), true);
});

test('detaching audio preserves other references and emits a sync update', async () => {
  const source = await uploadKaraoke(tokenA);
  const second = await post('/api/karaokes', tokenA, { name: 'Second reference', cloudUrl: source.body.cloudUrl });
  assert.equal(second.status, 200);
  const deleted = await post('/api/karaokes/delete-audio', tokenA, { id: source.body.id, baseVersion: source.body.version, cloudUrl: source.body.cloudUrl });
  assert.equal(deleted.status, 200);
  assert.equal(await prisma.karaoke.count({ where: { userId: userA.id, cloudUrl: source.body.cloudUrl } }), 1);
  assert.equal(fs.existsSync(safeUploadPath(source.body.cloudUrl)), true);
  const event = await prisma.syncChange.findFirst({ where: { entityId: source.body.id }, orderBy: { sequence: 'desc' } });
  assert.equal(JSON.parse(event.payload).data.file, null);
});

test('renaming a karaoke preserves audio and pitch while explicit zero is accepted', async () => {
  const source = await uploadKaraoke(tokenA, { pitchShift: 2 });
  let result = await request('/api/karaokes/' + source.body.id, tokenA, { method: 'PUT', body: JSON.stringify({ name: 'Renamed', baseVersion: source.body.version }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.hasLocalAudio, true);
  assert.equal(result.body.pitchShift, 2);
  result = await request('/api/karaokes/' + source.body.id, tokenA, { method: 'PUT', body: JSON.stringify({ pitchShift: 0, baseVersion: result.body.version }) });
  assert.equal(result.body.pitchShift, 0);
});

test('pitch processing uses argument arrays and deduplicates concurrent requests', async () => {
  const source = await uploadKaraoke(tokenA);
  const before = ffmpegCalls.length;
  const results = await Promise.all([1, 2].map(() => post('/api/karaokes/process-pitch', tokenA, { cloudUrl: source.body.cloudUrl, pitchShift: 2 })));
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(results[0].body.cloudUrl, results[1].body.cloudUrl);
  assert.equal(ffmpegCalls.length, before + 1);
  assert.equal(ffmpegCalls.at(-1).args.includes(safeUploadPath(source.body.cloudUrl)), true);
  assert.equal(ffmpegCalls.at(-1).options.timeout, 120000);
  assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: results[0].body.cloudUrl } })).userId, userA.id);
});

test('FFmpeg fallback resamples explicitly and stays within valid tempo limits', async () => {
  const source = await uploadKaraoke(tokenA);
  const before = ffmpegCalls.length;
  ffmpegMode = 'fallback';
  try {
    const response = await post('/api/karaokes/process-pitch', tokenA, { cloudUrl: source.body.cloudUrl, pitchShift: 24 });
    assert.equal(response.status, 200);
  } finally { ffmpegMode = 'normal'; }
  assert.equal(ffmpegCalls.length, before + 2);
  const args = ffmpegCalls.at(-1).args;
  assert.equal(args[args.indexOf('-af') + 1], 'aresample=44100,asetrate=44100*4,aresample=44100,atempo=0.5,atempo=0.5');
});

test('timed-out FFmpeg jobs do not start another expensive fallback or register files', async context => {
  context.mock.method(console, 'error', () => {});
  const source = await uploadKaraoke(tokenA);
  const before = ffmpegCalls.length;
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const beforeAssets = await prisma.fileAsset.count();
  ffmpegMode = 'timeout';
  try {
    const response = await post('/api/karaokes/process-pitch', tokenA, { cloudUrl: source.body.cloudUrl, pitchShift: 1 });
    assert.equal(response.status, 500);
  } finally { ffmpegMode = 'normal'; }
  assert.equal(ffmpegCalls.length, before + 1);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
  assert.equal(await prisma.fileAsset.count(), beforeAssets);
});

test('unattached downloads are owned and both download response formats remain compatible', async () => {
  const url = 'https://youtu.be/dQw4w9WgXcQ?list=ignored';
  const downloaded = await post('/api/karaokes/download-audio', tokenA, { url });
  assert.equal(downloaded.status, 200);
  assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: downloaded.body.cloudUrl } })).userId, userA.id);
  assert.equal((await post('/api/karaokes/process-pitch', tokenA, { cloudUrl: downloaded.body.cloudUrl, pitchShift: 0 })).status, 200);
  const extracted = await post('/api/youtube/extract', tokenA, { url });
  assert.equal(extracted.status, 200);
  assert.equal(extracted.body.success, true);
  assert.match(extracted.body.url, /^\/uploads\/[a-f0-9-]+\.mp3$/);
  const call = downloadCalls.at(-1);
  assert.equal(call.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(call.flags.noCheckCertificates, undefined);
  assert.equal(call.flags.noPlaylist, true);
  assert.equal(call.options.timeout, 180000);
});

test('metadata keeps its response format and uses certificate verification', async () => {
  const result = await request('/api/karaokes/youtube-metadata?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'), tokenA);
  assert.equal(result.status, 200);
  assert.equal(result.body.title, 'Test video');
  assert.equal(downloadCalls.at(-1).flags.noCheckCertificates, undefined);
});

test('failed downloads remove partial output and do not register an asset', async context => {
  context.mock.method(console, 'error', () => {});
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const beforeAssets = await prisma.fileAsset.count();
  downloadMode = 'failed';
  try {
    assert.equal((await post('/api/karaokes/download-audio', tokenA, { url: 'https://youtu.be/dQw4w9WgXcQ' })).status, 500);
  } finally { downloadMode = 'normal'; }
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
  assert.equal(await prisma.fileAsset.count(), beforeAssets);
});

test('a downloader result without an audio file returns an upstream error', async () => {
  const beforeAssets = await prisma.fileAsset.count();
  downloadMode = 'missing';
  try {
    const response = await post('/api/karaokes/download-audio', tokenA, { url: 'https://youtu.be/dQw4w9WgXcQ' });
    assert.equal(response.status, 502);
  } finally { downloadMode = 'normal'; }
  assert.equal(await prisma.fileAsset.count(), beforeAssets);
});

test('unsupported uploads and failed entity creation leave no files or asset records', async () => {
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const beforeAssets = await prisma.fileAsset.count();
  assert.equal((await uploadKaraoke(tokenA, {}, 'script.exe')).status, 400);
  assert.equal((await uploadKaraoke(tokenA, { name: '' })).status, 400);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
  assert.equal(await prisma.fileAsset.count(), beforeAssets);
});

test('nested multipart fields are rejected and any pending upload is removed', async () => {
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const form = new FormData();
  form.set('file', new Blob([Buffer.alloc(2000, 3)], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata[name]', 'Nested field');
  const response = await request('/api/karaokes', tokenA, { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'LIMIT_FIELD_NESTING');
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
});

test('JSON parse and size errors preserve their HTTP status', async () => {
  const malformed = await request('/api/sync/v2', tokenA, { method: 'POST', body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'invalid_json');
  const oversized = await post('/api/sync/v2', tokenA, { data: 'x'.repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
});

test('file ownership migration backfills unique owners without claiming shared legacy paths', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const migrations = path.resolve(__dirname, '../prisma/migrations');
  try {
    db.exec(fs.readFileSync(path.join(migrations, '20260621012303_init_catalog/migration.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migrations, '20260810000000_add_sync_v2/migration.sql'), 'utf8'));
    db.exec(`
      INSERT INTO User (id,email,passwordHash,updatedAt) VALUES ('a','a@test','x',CURRENT_TIMESTAMP),('b','b@test','x',CURRENT_TIMESTAMP);
      INSERT INTO Song (id,userId,name,cloudUrl,dateAdded,updatedAt) VALUES ('one','a','Owned','/uploads/owned.gp5',1,1),('two','a','Shared','/uploads/shared.mp3',1,1);
      INSERT INTO Karaoke (id,userId,name,cloudUrl,dateAdded,updatedAt) VALUES ('three','b','Shared','/uploads/shared.mp3',1,1);
    `);
    db.exec(fs.readFileSync(path.join(migrations, '20261004000000_add_file_ownership/migration.sql'), 'utf8'));
    assert.equal(db.prepare('SELECT userId FROM FileAsset WHERE cloudUrl=?').get('/uploads/owned.gp5').userId, 'a');
    assert.equal(db.prepare('SELECT userId FROM FileAsset WHERE cloudUrl=?').get('/uploads/shared.mp3'), undefined);
  } finally { db.close(); }
});
