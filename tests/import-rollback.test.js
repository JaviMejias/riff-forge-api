const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-import-rollback-');
const { app } = environment.load('index');
const { prisma } = environment.load('utils/prisma');
const { safeUploadPath } = environment.load('services/fileMetadata');
const specs = [
  { route: 'songs', model: 'song', table: 'Song', controller: 'songController', method: 'createSong', update: 'updateSong', extension: 'gp5' },
  { route: 'karaokes', model: 'karaoke', table: 'Karaoke', controller: 'karaokeController', method: 'createKaraoke', update: 'updateKaraoke', extension: 'mp3' }
];
const sources = new Map();
let owner;
let importer;
let token;
let server;
let baseUrl;

async function request(spec, data) {
  const response = await fetch(`${baseUrl}/api/${spec.route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(data)
  });
  return { status: response.status, body: await response.json() };
}

async function snapshot() {
  const filenames = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const files = filenames.map(name => {
    const contents = fs.readFileSync(safeUploadPath('/uploads/' + name));
    return [name, crypto.createHash('sha256').update(contents).digest('hex')];
  });
  return {
    files,
    songs: await prisma.song.findMany({ orderBy: { id: 'asc' } }),
    karaokes: await prisma.karaoke.findMany({ orderBy: { id: 'asc' } }),
    assets: await prisma.fileAsset.findMany({ orderBy: { cloudUrl: 'asc' } }),
    events: await prisma.syncChange.findMany({ orderBy: { sequence: 'asc' } })
  };
}

test.before(async () => {
  owner = await prisma.user.create({ data: { email: 'import-owner@example.test', passwordHash: 'unused' } });
  importer = await prisma.user.create({ data: { email: 'import-target@example.test', passwordHash: 'unused' } });
  token = jwt.sign({ userId: importer.id }, process.env.JWT_SECRET);
  for (const spec of specs) {
    const cloudUrl = `/uploads/public-source.${spec.extension}`;
    const bytes = Buffer.from(`Public source for ${spec.model}`);
    fs.writeFileSync(safeUploadPath(cloudUrl), bytes);
    await prisma.fileAsset.create({ data: { cloudUrl, userId: owner.id, createdAt: 1n } });
    const entity = await prisma[spec.model].create({ data: {
      name: 'Public source', userId: owner.id, isPublic: true, cloudUrl, dateAdded: 1n, createdAt: 1n, updatedAt: 1n
    } });
    sources.set(spec.model, { entity, cloudUrl, bytes });
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

for (const spec of specs) {
  for (const stage of ['entity', 'event', 'ownership']) {
    test(`${spec.model} import removes its new copy if ${stage} persistence fails`, async context => {
      context.mock.method(console, 'error', () => {});
      const before = await snapshot();
      const table = stage === 'entity' ? spec.table : stage === 'event' ? 'SyncChange' : 'FileAsset';
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_import_write BEFORE INSERT ON "${table}"
        BEGIN SELECT RAISE(FAIL, 'simulated_import_failure'); END`);
      try {
        const result = await request(spec, { name: 'Rejected import', cloudUrl: sources.get(spec.model).cloudUrl });
        assert.equal(result.status, 500);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER fail_import_write');
      }
    });
  }

  test(`${spec.model} failed reuse never deletes an existing owned file`, async context => {
    context.mock.method(console, 'error', () => {});
    const cloudUrl = `/uploads/owned-existing.${spec.extension}`;
    fs.writeFileSync(safeUploadPath(cloudUrl), Buffer.from('Existing importer file'));
    await prisma.fileAsset.create({ data: { cloudUrl, userId: importer.id, createdAt: 1n } });
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_owned_reuse BEFORE INSERT ON "SyncChange"
      BEGIN SELECT RAISE(FAIL, 'simulated_owned_reuse_failure'); END`);
    try {
      assert.equal((await request(spec, { name: 'Reuse failure', cloudUrl })).status, 500);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_owned_reuse');
    }
  });

  test(`${spec.model} copy-name collision never removes another existing file`, async context => {
    context.mock.method(console, 'error', () => {});
    const collision = '00000000-0000-4000-8000-000000000001';
    const cloudUrl = `/uploads/${collision}.${spec.extension}`;
    fs.writeFileSync(safeUploadPath(cloudUrl), Buffer.from('Unrelated existing file'));
    await prisma.fileAsset.create({ data: { cloudUrl, userId: owner.id, createdAt: 1n } });
    const before = await snapshot();
    context.mock.method(crypto, 'randomUUID', () => collision);
    assert.equal((await request(spec, { name: 'Collision', cloudUrl: sources.get(spec.model).cloudUrl })).status, 500);
    assert.deepEqual(await snapshot(), before);
  });

  test(`${spec.model} successful public import keeps independent bytes and a matching sync snapshot`, async () => {
    const source = sources.get(spec.model);
    const result = await request(spec, { name: 'Successful import', cloudUrl: source.cloudUrl });
    assert.equal(result.status, 200);
    assert.notEqual(result.body.cloudUrl, source.cloudUrl);
    assert.equal(result.body.version, 1);
    assert.equal(result.body.fileVersion, 1);
    assert.equal(result.body.fileSize, String(source.bytes.length));
    assert.equal(result.body.fileHash, crypto.createHash('sha256').update(source.bytes).digest('hex'));
    assert.deepEqual(fs.readFileSync(safeUploadPath(result.body.cloudUrl)), source.bytes);
    assert.deepEqual(fs.readFileSync(safeUploadPath(source.cloudUrl)), source.bytes);
    assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: result.body.cloudUrl } })).userId, importer.id);
    const event = await prisma.syncChange.findFirst({ where: { entityId: result.body.id } });
    assert.equal(JSON.parse(event.payload).data.file.url, result.body.cloudUrl);
  });

  test(`${spec.model} failed partial copy removes only its new destination`, async context => {
    context.mock.method(console, 'error', () => {});
    const before = await snapshot();
    context.mock.method(fs.promises, 'copyFile', async (sourcePath, destinationPath, flags) => {
      assert.equal(sourcePath, safeUploadPath(sources.get(spec.model).cloudUrl));
      assert.equal(flags, fs.constants.COPYFILE_EXCL);
      assert.ok(destinationPath.startsWith(process.env.UPLOAD_DIR + '/'));
      fs.writeFileSync(destinationPath, Buffer.from('Partial copy'));
      throw Object.assign(new Error('Simulated copy failure'), { code: 'EIO' });
    });
    assert.equal((await request(spec, { name: 'Partial copy failure', cloudUrl: sources.get(spec.model).cloudUrl })).status, 500);
    assert.deepEqual(await snapshot(), before);
  });

  test(`${spec.model} response failure does not discard a successfully committed import`, async () => {
    const source = sources.get(spec.model);
    const { [spec.method]: create } = environment.load('controllers/' + spec.controller);
    const responseError = new Error('Simulated response failure');
    let result;
    let forwarded;
    await create({ body: { name: 'Committed import', cloudUrl: source.cloudUrl }, userId: importer.id }, {
      json: value => { result = value; throw responseError; }
    }, error => { forwarded = error; });
    assert.equal(forwarded, responseError);
    assert.equal((await prisma[spec.model].findUnique({ where: { id: result.id } })).cloudUrl, result.cloudUrl);
    assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: result.cloudUrl } })).userId, importer.id);
    assert.deepEqual(fs.readFileSync(safeUploadPath(result.cloudUrl)), source.bytes);
    assert.ok(await prisma.syncChange.findFirst({ where: { entityId: result.id } }));
  });

  for (const action of ['create', 'update']) {
    test(`${spec.model} ${action} response failure preserves its committed multipart upload`, async () => {
      const existing = action === 'update' ? await request(spec, { name: 'Before upload' }) : null;
      const filename = `committed-${spec.model}-${action}.${spec.extension}`;
      const filePath = safeUploadPath('/uploads/' + filename);
      const bytes = Buffer.from(`Committed upload for ${spec.model} ${action}`);
      fs.writeFileSync(filePath, bytes);
      const controller = environment.load('controllers/' + spec.controller)[action === 'create' ? spec.method : spec.update];
      const responseError = new Error('Simulated upload response failure');
      let result;
      let forwarded;
      await controller({
        body: { name: 'Committed upload', ...(existing ? { baseVersion: existing.body.version } : {}) },
        params: existing ? { id: existing.body.id } : {}, userId: importer.id, get: () => undefined,
        file: { filename, path: filePath, mimetype: 'application/octet-stream' }
      }, { json: value => { result = value; throw responseError; } }, error => { forwarded = error; });
      assert.equal(forwarded, responseError);
      assert.deepEqual(fs.readFileSync(filePath), bytes);
      const saved = await prisma[spec.model].findUnique({ where: { id: result.id } });
      assert.equal(saved.cloudUrl, '/uploads/' + filename);
      assert.equal(saved.fileHash, crypto.createHash('sha256').update(bytes).digest('hex'));
      assert.equal((await prisma.fileAsset.findUnique({ where: { cloudUrl: saved.cloudUrl } })).userId, importer.id);
      assert.ok(await prisma.syncChange.findFirst({ where: { entityId: saved.id, version: saved.version } }));
    });
  }

  test(`${spec.model} a failed import does not discard another successful request copy`, async context => {
    context.mock.method(console, 'error', () => {});
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_one_import BEFORE INSERT ON "${spec.table}"
      WHEN NEW."name" = 'Reject this import'
      BEGIN SELECT RAISE(FAIL, 'simulated_one_import_failure'); END`);
    try {
      const source = sources.get(spec.model);
      const [failed, succeeded] = await Promise.all([
        request(spec, { name: 'Reject this import', cloudUrl: source.cloudUrl }),
        request(spec, { name: 'Keep this import', cloudUrl: source.cloudUrl })
      ]);
      assert.equal(failed.status, 500);
      assert.equal(succeeded.status, 200);
      assert.deepEqual(fs.readFileSync(safeUploadPath(succeeded.body.cloudUrl)), source.bytes);
      const after = await snapshot();
      assert.equal(after.files.length, before.files.length + 1);
      assert.equal(after.assets.length, before.assets.length + 1);
      assert.equal(after.events.length, before.events.length + 1);
      assert.equal(after[spec.route].length, before[spec.route].length + 1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_one_import');
    }
  });
}

test('private content and malformed references fail without making copies or changing existing files', async () => {
  for (const spec of specs) {
    const source = sources.get(spec.model);
    await prisma[spec.model].update({ where: { id: source.entity.id }, data: { isPublic: false } });
    const before = await snapshot();
    assert.equal((await request(spec, { name: 'Private import', cloudUrl: source.cloudUrl })).status, 404);
    assert.equal((await request(spec, { name: 'Malformed import', cloudUrl: '/uploads/../private' })).status, 400);
    assert.deepEqual(await snapshot(), before);
    await prisma[spec.model].update({ where: { id: source.entity.id }, data: { isPublic: true } });
  }
});
