const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-audio-jobs-');
const calls = { download: [], ffmpeg: [] };
const holds = { download: [], ffmpeg: [] };
let metadataValue = { title: 'Test video' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function holdNext(kind) {
  const started = deferred();
  const completion = deferred();
  holds[kind].push({ started, completion });
  return { started: started.promise, release: error => completion.resolve(error) };
}

async function enterProcess(kind, call) {
  calls[kind].push(call);
  const hold = holds[kind].shift();
  if (hold) {
    hold.started.resolve();
    const error = await hold.completion.promise;
    if (error) throw error;
  }
}

test.mock.method(childProcess, 'execFile', (binary, args, options, callback) => {
  assert.equal(binary, 'ffmpeg');
  enterProcess('ffmpeg', { args, options }).then(() => {
    fs.writeFileSync(args.at(-1), Buffer.alloc(2000, 1));
    callback(null, '', '');
  }, callback);
});

test.mock.method(require('youtube-dl-exec'), 'exec', async (url, flags, options) => {
  await enterProcess('download', { url, flags, options });
  if (flags.output) fs.writeFileSync(flags.output, Buffer.alloc(2000, 2));
  return { exitCode: 0, stdout: JSON.stringify(metadataValue), stderr: '' };
});

const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { safeUploadPath } = environment.load('services/fileMetadata');
const { processAudioPitch } = environment.load('services/audioService');
const tokens = [];
const users = [];
const sources = [];
const url = 'https://youtu.be/dQw4w9WgXcQ';
let server;
let baseUrl;

async function request(endpoint, token, body) {
  const response = await fetch(baseUrl + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const download = token => request('/api/karaokes/download-audio', token, { url });
const metadata = token => request('/api/karaokes/youtube-metadata?url=' + encodeURIComponent(url), token);
const pitch = (index, shift = 1) => request('/api/karaokes/process-pitch', tokens[index], { cloudUrl: sources[index], pitchShift: shift });

test.before(async () => {
  for (let index = 0; index < 3; index++) {
    const user = await prisma.user.create({ data: { email: `audio-job-${index}@example.test`, passwordHash: 'unused' } });
    users.push(user);
    tokens.push(jwt.sign({ userId: user.id }, process.env.JWT_SECRET));
    const cloudUrl = `/uploads/source-${index}.mp3`;
    fs.writeFileSync(safeUploadPath(cloudUrl), Buffer.alloc(2000, 3));
    await prisma.fileAsset.create({ data: { cloudUrl, userId: user.id, createdAt: 1n } });
    sources.push(cloudUrl);
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
  test.mock.restoreAll();
  environment.cleanup();
});

test('one owner cannot bypass the shared job limit through another downloader route or metadata', async () => {
  const hold = holdNext('download');
  const running = download(tokens[0]);
  try {
    await hold.started;
    const beforeCalls = calls.download.length;
    const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
    const beforeAssets = await prisma.fileAsset.count();
    for (const response of [
      await download(tokens[0]),
      await request('/api/youtube/extract', tokens[0], { url }),
      await metadata(tokens[0]),
      await pitch(0)
    ]) {
      assert.equal(response.status, 429);
      assert.equal(response.body.code, 'audio_job_limit');
      assert.equal(response.headers.get('retry-after'), '5');
      assert.equal(response.body.retryAfterSeconds, 5);
    }
    assert.equal(calls.download.length, beforeCalls);
    assert.equal(calls.ffmpeg.length, 0);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
    assert.equal(await prisma.fileAsset.count(), beforeAssets);
  } finally {
    hold.release();
    await running;
  }
  assert.equal((await download(tokens[0])).status, 200);
});

test('different users share a two-job capacity across downloader and FFmpeg work', async () => {
  const downloadHold = holdNext('download');
  const pitchHold = holdNext('ffmpeg');
  const first = download(tokens[0]);
  const second = pitch(1);
  try {
    await Promise.all([downloadHold.started, pitchHold.started]);
    const before = { download: calls.download.length, ffmpeg: calls.ffmpeg.length };
    for (const response of [await download(tokens[2]), await metadata(tokens[2]), await pitch(2)]) {
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'audio_capacity_exceeded');
      assert.equal(response.headers.get('retry-after'), '5');
    }
    assert.equal(calls.download.length, before.download);
    assert.equal(calls.ffmpeg.length, before.ffmpeg);
    downloadHold.release();
    assert.equal((await first).status, 200);
    assert.equal((await download(tokens[2])).status, 200);
  } finally {
    downloadHold.release();
    pitchHold.release();
    await Promise.allSettled([first, second]);
  }
  assert.equal((await second).status, 200);
});

test('identical pitch requests share one job and cache hits or zero pitch need no capacity', async () => {
  const hold = holdNext('ffmpeg');
  const first = pitch(0, 2);
  let duplicate;
  try {
    await hold.started;
    const before = calls.ffmpeg.length;
    duplicate = processAudioPitch(users[0].id, sources[0], 2);
    assert.equal((await pitch(0, 3)).status, 429);
    assert.equal((await pitch(0, 0)).status, 200);
    hold.release();
    const result = await first;
    assert.equal(result.status, 200);
    assert.equal(await duplicate, result.body.cloudUrl);
    assert.equal(calls.ffmpeg.length, before);
  } finally {
    hold.release();
    await Promise.allSettled([first, duplicate]);
  }
  const downloadHold = holdNext('download');
  const otherHold = holdNext('download');
  const downloads = [download(tokens[0]), download(tokens[1])];
  try {
    await Promise.all([downloadHold.started, otherHold.started]);
    const before = calls.ffmpeg.length;
    assert.equal((await pitch(0, 2)).status, 200);
    assert.equal(calls.ffmpeg.length, before);
  } finally {
    downloadHold.release();
    otherHold.release();
    await Promise.allSettled(downloads);
  }
});

test('failed and timed-out jobs release capacity without leaving partial assets', async context => {
  context.mock.method(console, 'error', () => {});
  for (const kind of ['download', 'ffmpeg']) {
    const hold = holdNext(kind);
    const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
    const beforeAssets = await prisma.fileAsset.count();
    const running = kind === 'download' ? download(tokens[0]) : pitch(0, 4);
    await hold.started;
    hold.release(Object.assign(new Error('Simulated timeout'), { killed: true }));
    assert.equal((await running).status, 500);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
    assert.equal(await prisma.fileAsset.count(), beforeAssets);
    assert.equal((await metadata(tokens[0])).status, 200);
  }
});

test('unauthenticated and invalid requests do not consume native process capacity', async () => {
  const before = calls.download.length;
  assert.equal((await download(null)).status, 401);
  assert.equal((await request('/api/karaokes/download-audio', tokens[0], { url: 'https://invalid.example' })).status, 400);
  assert.equal(calls.download.length, before);
  assert.equal((await metadata(tokens[0])).status, 200);
});

test('FFmpeg fallback retains the same job slot until conversion finishes', async () => {
  const firstHold = holdNext('ffmpeg');
  const fallbackHold = holdNext('ffmpeg');
  const before = calls.ffmpeg.length;
  const running = pitch(2, 6);
  try {
    await firstHold.started;
    firstHold.release(new Error('Simulated missing filter'));
    await fallbackHold.started;
    assert.equal(calls.ffmpeg.length, before + 2);
    assert.equal((await metadata(tokens[2])).status, 429);
  } finally {
    firstHold.release();
    fallbackHold.release();
    await running;
  }
  assert.equal((await running).status, 200);
  assert.equal((await metadata(tokens[2])).status, 200);
});

test('failed generated-file registration removes its output and releases capacity', async context => {
  context.mock.method(console, 'error', () => {});
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const beforeAssets = await prisma.fileAsset.count();
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_audio_registration BEFORE INSERT ON "FileAsset"
    BEGIN SELECT RAISE(FAIL, 'simulated_audio_registration_failure'); END`);
  try {
    for (const work of [() => download(tokens[0]), () => pitch(0, 7)]) {
      assert.equal((await work()).status, 500);
      assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
      assert.equal(await prisma.fileAsset.count(), beforeAssets);
      assert.equal((await metadata(tokens[0])).status, 200);
    }
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_audio_registration');
  }
  assert.equal((await download(tokens[0])).status, 200);
  assert.equal((await pitch(0, 7)).status, 200);
});

test('job slots are released after a callback throws synchronously', async () => {
  const { runAudioJob } = environment.load('services/audioJobs');
  const failure = new Error('Synchronous callback failure');
  await assert.rejects(runAudioJob('synchronous-test-owner', () => { throw failure; }), error => error === failure);
  assert.equal(await runAudioJob('synchronous-test-owner', async () => 'complete'), 'complete');
});

test('failed pitch publication rolls back ownership registration and releases capacity', async context => {
  context.mock.method(console, 'error', () => {});
  const beforeFiles = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const beforeAssets = await prisma.fileAsset.count();
  context.mock.method(fs.promises, 'rename', async () => { throw new Error('Simulated publication failure'); });
  assert.equal((await pitch(0, 8)).status, 500);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), beforeFiles);
  assert.equal(await prisma.fileAsset.count(), beforeAssets);
  assert.equal((await metadata(tokens[0])).status, 200);
});

test('null or malformed upstream metadata returns 502 and releases its job slot', async () => {
  try {
    for (const value of [null, {}, { title: 42 }]) {
      metadataValue = value;
      assert.equal((await metadata(tokens[0])).status, 502);
    }
  } finally { metadataValue = { title: 'Test video' }; }
  assert.equal((await metadata(tokens[0])).status, 200);
});

test('cross-origin clients can read the Retry-After header without changing success formats', async () => {
  const response = await request('/api/youtube/extract', tokens[0], { url });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.url, /^\/uploads\/[a-f0-9-]+\.mp3$/);
  const exposed = response.headers.get('access-control-expose-headers').toLowerCase();
  assert.ok(exposed.includes('retry-after'));
});
