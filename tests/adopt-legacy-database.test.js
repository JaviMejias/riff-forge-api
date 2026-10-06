const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/adopt-legacy-database.js');
let directory;

test.beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-forge-adoption-test-')); });
test.afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function legacy() {
  const filename = path.join(directory, 'legacy.db');
  const database = new DatabaseSync(filename);
  for (const name of ['20260621012303_init_catalog', '20260810000000_add_sync_v2']) {
    database.exec(fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
  }
  database.exec(`INSERT INTO User (id,email,passwordHash,updatedAt) VALUES ('owner','private@example.test','private-secret',1);
    INSERT INTO Song (id,userId,name,dateAdded,updatedAt,cloudUrl) VALUES ('song','owner','Legacy',10,20,'/uploads/legacy.gp');
    INSERT INTO Karaoke (id,userId,name,dateAdded,updatedAt,createdAt,fileVersion,cloudUrl,version,hasLocalAudio) VALUES ('karaoke','owner','Modern',10,20,10,3,'/uploads/modern.mp3',7,1);
    INSERT INTO Playlist (id,userId,name,createdAt,updatedAt,songCloudIds,version) VALUES ('playlist','owner','Ordered',10,20,'["song"]',4);
    INSERT INTO SyncChange (userId,entityType,entityId,version,action,payload,createdAt) VALUES ('owner','song','song',1,'upsert','{"immutable":true}',20);`);
  database.close();
  return filename;
}

function run(filename, args = [], overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: directory, env: { ...process.env, DATABASE_URL: `file:${filename}`, ...overrides }, encoding: 'utf8'
  });
}

test('inspection is read-only and exposes counts, not personal records', () => {
  const filename = legacy();
  const before = fs.readFileSync(filename);
  const result = run(filename);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'read-only');
  assert.equal(report.repairs.Song, 1);
  assert.equal(report.repairs.Karaoke, 0);
  assert.equal(report.counts.User, 1);
  assert.doesNotMatch(result.stdout, /private@example|private-secret/);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('inspection does not create a missing database', () => {
  const filename = path.join(directory, 'missing.db');
  assert.notEqual(run(filename).status, 0);
  assert.equal(fs.existsSync(filename), false);
});

test('adoption refuses unknown schemas and does not create a backup or modify data', () => {
  const filename = legacy();
  const database = new DatabaseSync(filename);
  database.exec('ALTER TABLE Song ADD COLUMN unexpected TEXT');
  database.close();
  const before = fs.readFileSync(filename);
  const backupPath = path.join(directory, 'backup.db');
  const result = run(filename, ['--apply', '--maintenance', '--backup', backupPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Schema does not exactly match/);
  assert.equal(fs.existsSync(backupPath), false);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('apply requires explicit maintenance and refuses overwriting backups', () => {
  const filename = legacy();
  const backupPath = path.join(directory, 'backup.db');
  assert.notEqual(run(filename, ['--apply', '--backup', backupPath]).status, 0);
  assert.equal(fs.existsSync(backupPath), false);
  fs.copyFileSync(filename, backupPath);
  const before = fs.readFileSync(filename);
  const backupBefore = fs.readFileSync(backupPath);
  assert.notEqual(run(filename, ['--apply', '--maintenance', '--backup', backupPath]).status, 0);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
});

test('adoption rehearses, repairs only missing metadata, preserves snapshots and applies pending migrations', () => {
  const filename = legacy();
  const backupPath = path.join(directory, 'backup.db');
  const result = run(filename, ['--apply', '--maintenance', '--backup', backupPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rehearsed successfully/);
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  const database = new DatabaseSync(filename, { readOnly: true });
  const saved = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const song = database.prepare('SELECT * FROM Song').get();
    assert.equal(song.createdAt, 10);
    assert.equal(song.fileVersion, 1);
    assert.equal(song.version, 2);
    assert.equal(saved.prepare('SELECT createdAt FROM Song').get().createdAt, 0);
    assert.equal(saved.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='_prisma_migrations'").get().count, 0);
    const modern = database.prepare('SELECT * FROM Karaoke').get();
    assert.equal(modern.version, 7);
    assert.equal(modern.updatedAt, 20);
    assert.equal(modern.fileVersion, 3);
    const playlist = database.prepare('SELECT * FROM Playlist').get();
    assert.equal(playlist.songCloudIds, '["song"]');
    assert.equal(playlist.version, 4);
    const changes = database.prepare("SELECT * FROM SyncChange WHERE entityType='song' ORDER BY sequence").all();
    assert.equal(changes[0].payload, '{"immutable":true}');
    const payload = JSON.parse(changes[1].payload);
    assert.equal(payload.version, 2);
    assert.equal(payload.createdAt, 10);
    assert.equal(payload.data.file.version, 1);
    assert.equal(payload.data.isPublic, false);
    assert.equal(database.prepare('SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').get().count, 4);
    assert.equal(database.prepare('SELECT count(*) AS count FROM FileAsset').get().count, 2);
  } finally {
    database.close();
    saved.close();
  }
  assert.notEqual(run(filename).status, 0, 'Adoption must not be repeated on a migrated database');
});

test('extra unique constraints are rejected even when columns match', () => {
  const filename = legacy();
  const database = new DatabaseSync(filename);
  database.exec('CREATE UNIQUE INDEX unexpected_unique ON Song(name)');
  database.close();
  assert.notEqual(run(filename).status, 0);
});

test('rehearsal failure preserves the live database and keeps the verified backup', () => {
  const filename = legacy();
  const before = fs.readFileSync(filename);
  const backupPath = path.join(directory, 'backup.db');
  const result = run(filename, ['--apply', '--maintenance', '--backup', backupPath], { RIFF_TEST_BUILD_DIR: path.join(directory, 'missing-build') });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(filename), before);
  const saved = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(saved.prepare('SELECT count(*) AS count FROM Song').get().count, 1);
    assert.equal(saved.prepare('SELECT createdAt FROM Song').get().createdAt, 0);
  } finally { saved.close(); }
});

test('adoption backs up committed WAL data and refuses an open competing connection before repairs', () => {
  const filename = legacy();
  const writer = new DatabaseSync(filename);
  const backupPath = path.join(directory, 'wal-backup.db');
  try {
    writer.exec("PRAGMA journal_mode=WAL; UPDATE Song SET name='Committed in WAL'");
    const result = run(filename, ['--apply', '--maintenance', '--backup', backupPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /locked|Close all database connections/);
    assert.equal(writer.prepare('SELECT version FROM Song').get().version, 1);
    const saved = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(saved.prepare('SELECT name FROM Song').get().name, 'Committed in WAL'); }
    finally { saved.close(); }
  } finally { writer.close(); }
  const resumed = run(filename, ['--apply', '--maintenance', '--backup', path.join(directory, 'closed-backup.db')]);
  assert.equal(resumed.status, 0, resumed.stderr);
});
