const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-catalog-files-');
const dataDir = path.join(environment.testDir, 'data');
process.env.CATALOG_DATA_DIR = dataDir;
const outside = path.join(environment.testDir, 'outside.gp5');
const relativePath = 'catalog/extracted/Artista con espacios/Canción.gp5';
const filename = path.join(dataDir, relativePath);
const bytes = Buffer.from('Fixture Guitar Pro bytes for range testing');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
let server;
let baseUrl;
let token;

async function tab(filePath = relativePath, attributes = {}) {
  return prisma.catalogTab.create({ data: { artist: 'Artista', title: 'Canción', format: 'gp5', filePath, ...attributes } });
}

async function request(id, options = {}) {
  const response = await fetch(`${baseUrl}/api/catalog/${id}/download`, {
    ...options,
    headers: { authorization: 'Bearer ' + token, ...options.headers }
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}

test.before(async () => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  fs.writeFileSync(outside, 'Private file outside the catalogue root');
  const user = await prisma.user.create({ data: { email: 'catalog-files@example.test', passwordHash: 'unused' } });
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
  await prisma.catalogTab.deleteMany();
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  environment.cleanup();
});

test('authenticated catalogue downloads use the configured root and preserve bytes and filename', async () => {
  const entry = await tab();
  const response = await request(entry.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, bytes);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.match(response.headers.get('content-disposition'), /gp5/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('vary'), /Authorization/i);
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('nested legacy paths with Windows separators are resolved safely', async () => {
  const entry = await tab(relativePath.replaceAll('/', '\\'), { format: 'GP5' });
  const response = await request(entry.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, bytes);
});

test('GET ranges and HEAD stay supported behind authentication', async () => {
  const entry = await tab();
  const range = await request(entry.id, { headers: { range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.deepEqual(range.bytes, bytes.subarray(0, 7));
  assert.equal(range.headers.get('content-range'), `bytes 0-6/${bytes.length}`);
  const head = await request(entry.id, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
});

test('unknown IDs, missing files and directories return JSON 404 rather than leaking file paths', async () => {
  const directory = path.join(dataDir, 'folder.gp5');
  fs.mkdirSync(directory);
  const entries = [await tab('catalog/missing.gp5'), await tab('folder.gp5')];
  for (const id of ['unknown-id', ...entries.map(entry => entry.id)]) {
    const result = await request(id);
    assert.equal(result.status, 404);
    assert.equal(typeof JSON.parse(result.bytes.toString()).error, 'string');
    assert.equal(result.bytes.toString().includes(environment.testDir), false);
  }
});

test('relative traversal from a catalogue record cannot download an external file', async () => {
  // The old implementation resolves against the temporary compilation's data directory.
  const oldRoot = path.resolve(process.env.RIFF_TEST_BUILD_DIR, '../data');
  for (const filePath of [path.relative(oldRoot, outside), '../outside.gp5', '..\\outside.gp5']) {
    const entry = await tab(filePath);
    assert.equal((await request(entry.id)).status, 404, filePath);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Private file outside the catalogue root');
});

test('absolute POSIX, Windows and UNC catalogue paths are rejected', async () => {
  for (const filePath of [filename, outside, 'C:\\private\\file.gp5', '\\\\server\\share\\file.gp5', '\\private\\file.gp5']) {
    const entry = await tab(filePath);
    assert.equal((await request(entry.id)).status, 404, filePath);
  }
});

test('catalogue records cannot download database, config or unsupported file types', async () => {
  for (const name of ['database.db', 'archive.zip', 'settings.json', 'audio.mp3']) {
    fs.writeFileSync(path.join(dataDir, name), 'Private non-tablature fixture');
    for (const format of ['gp5', path.extname(name).slice(1)]) {
      const entry = await tab(name, { format });
      assert.equal((await request(entry.id)).status, 404);
    }
  }
  const mismatch = await tab(relativePath, { format: 'gp3' });
  assert.equal((await request(mismatch.id)).status, 404);
});

test('hidden and malformed catalogue paths are rejected', async () => {
  const hidden = '.private.gp5';
  fs.writeFileSync(path.join(dataDir, hidden), 'Private hidden fixture');
  for (const filePath of [hidden, '', '.', relativePath + '\0', 'catalog/../' + relativePath, 'x'.repeat(5000) + '.gp5']) {
    const entry = await tab(filePath);
    assert.equal((await request(entry.id)).status, 404);
  }
});

test('final symlinks are rejected even when they point to a file inside the allowed root', async () => {
  for (const [name, target] of [['inside-link.gp5', filename], ['outside-link.gp5', outside]]) {
    fs.symlinkSync(target, path.join(dataDir, name));
    const entry = await tab(name);
    assert.equal((await request(entry.id)).status, 404);
    assert.equal(fs.lstatSync(path.join(dataDir, name)).isSymbolicLink(), true);
  }
});

test('a symlink in a parent directory cannot escape into an adjacent directory', async () => {
  fs.symlinkSync(environment.testDir, path.join(dataDir, 'escaped'));
  const entry = await tab('escaped/outside.gp5');
  assert.equal((await request(entry.id)).status, 404);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Private file outside the catalogue root');
});

test('filenames from metadata are bounded and do not contain path or header-control characters', async () => {
  const entry = await tab(relativePath, { artist: 'Artista/\\\r\n' + 'A'.repeat(3000), title: '../Título\r\n' });
  const response = await request(entry.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, bytes);
  const header = response.headers.get('content-disposition');
  assert.ok(header.length < 2000);
  assert.equal(/[\r\n]/.test(header), false);
  assert.match(header, /\.gp5/);
});

test('asynchronous missing-file transfer errors preserve JSON 404 and remove download-only headers', async context => {
  context.mock.method(express.response, 'download', function (_file, _name, options, callback) {
    assert.equal(typeof options, 'object');
    this.set('Content-Disposition', 'attachment; filename="fixture.gp5"');
    this.set('Content-Type', 'application/octet-stream');
    this.set('Content-Length', '9000');
    setImmediate(() => callback(Object.assign(new Error('Fixture missing file'), { code: 'ENOENT', status: 404 })));
    return this;
  });
  const entry = await tab();
  const response = await request(entry.id);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(typeof JSON.parse(response.bytes.toString()).error, 'string');
});

test('unexpected asynchronous transfer errors retain the existing 500 response contract', async context => {
  context.mock.method(express.response, 'download', function (_file, _name, _options, callback) {
    setImmediate(() => callback(Object.assign(new Error('Private transfer fixture'), { code: 'EIO' })));
    return this;
  });
  const entry = await tab();
  const response = await request(entry.id);
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.bytes.toString()), { error: 'Failed to download tab' });
});

test('invalid byte ranges produce 416 without changing successful download contracts', async () => {
  const entry = await tab();
  const response = await request(entry.id, { headers: { range: 'bytes=9999-10000' } });
  assert.equal(response.status, 416);
  assert.equal(typeof JSON.parse(response.bytes.toString()).error, 'string');
});

test('catalogue transfer failures after headers close the stream and log only safe diagnostics', async context => {
  const logs = [];
  context.mock.method(console, 'error', (...args) => logs.push(args));
  context.mock.method(express.response, 'download', function (_file, _name, _options, callback) {
    this.set('Content-Type', 'application/octet-stream');
    this.write('Partial fixture bytes');
    setTimeout(() => callback(Object.assign(new Error('PRIVATE catalogue stream failure'), { code: 'EIO' })), 20);
    return this;
  });
  const entry = await tab();
  const response = await fetch(`${baseUrl}/api/catalog/${entry.id}/download`, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
  assert.equal(logs.length, 1);
  const diagnostic = JSON.parse(logs[0][0]);
  assert.equal(diagnostic.requestId, response.headers.get('x-request-id'));
  assert.equal(diagnostic.event, 'request_aborted');
  assert.equal(diagnostic.scope, '/api/catalog');
  assert.equal(diagnostic.errorCode, 'EIO');
  assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
});

test('unexpected catalogue inspection failures retain the download 500 contract', async context => {
  const original = fs.promises.lstat;
  context.mock.method(fs.promises, 'lstat', async value => {
    if (value === filename) throw Object.assign(new Error('Fixture inspection denied'), { code: 'EACCES' });
    return original(value);
  });
  const entry = await tab();
  const response = await request(entry.id);
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.bytes.toString()), { error: 'Failed to download tab' });
});

test('catalogue file resolution rejects non-string metadata before inspecting the filesystem', async context => {
  const { resolveCatalogFile, catalogDownloadName } = environment.load('services/catalogFiles');
  let inspections = 0;
  context.mock.method(fs.promises, 'lstat', async () => { inspections++; throw new Error('Unexpected inspection'); });
  for (const value of [null, undefined, [], {}, true, 42]) {
    assert.equal(await resolveCatalogFile(value, 'gp5'), null);
    assert.equal(await resolveCatalogFile(relativePath, value), null);
  }
  assert.equal(inspections, 0);
  const name = catalogDownloadName('🎸'.repeat(200), '\ud800', 'GP5');
  assert.ok(Array.from(name).length <= 124);
  assert.equal(name.endsWith('.gp5'), true);
  assert.doesNotThrow(() => encodeURIComponent(name));
});

test('successful and conditional downloads still require a valid token', async () => {
  const entry = await tab();
  for (const method of ['GET', 'HEAD']) {
    const response = await request(entry.id, { method, headers: { authorization: '', 'if-none-match': '*' } });
    assert.equal(response.status, 401);
  }
  assert.deepEqual((await request(entry.id)).bytes, bytes);
});
