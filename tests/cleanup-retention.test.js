const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createEnvironment } = require('./helpers/environment');

const environment = createEnvironment('riff-forge-cleanup-retention-');
const database = new DatabaseSync(process.env.DATABASE_URL.slice(5));
database.exec('PRAGMA foreign_keys = ON');
const uploadDir = process.env.UPLOAD_DIR;
const root = path.resolve(__dirname, '..');
const script = path.join(process.env.RIFF_TEST_BUILD_DIR, 'scripts/cleanup-sync.js');
const now = Date.now();
const old = now - 200 * 24 * 60 * 60 * 1000;
const tables = ['ProcessedSyncOperation', 'SyncChange', 'Song', 'Karaoke', 'Playlist', 'KaraokePlaylist', 'CustomChord', 'FileAsset', 'User'];

function file(name, assetCreatedAt = old, modifiedAt = old) {
  fs.writeFileSync(path.join(uploadDir, name), Buffer.from(`Fixture ${name}`));
  fs.utimesSync(path.join(uploadDir, name), modifiedAt / 1000, modifiedAt / 1000);
  database.prepare('INSERT INTO FileAsset (cloudUrl,userId,createdAt) VALUES (?,?,?)').run('/uploads/' + name, 'owner', assetCreatedAt);
}

function receipt(id, createdAt, result) {
  database.prepare('INSERT INTO ProcessedSyncOperation (userId,deviceId,operationId,result,createdAt) VALUES (?,?,?,?,?)')
    .run('owner', 'device', id, JSON.stringify(result), createdAt);
}

function state() {
  return {
    rows: tables.map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
    files: fs.readdirSync(uploadDir).sort().map(name => {
      const filename = path.join(uploadDir, name);
      const stat = fs.lstatSync(filename);
      return [name, stat.isFile() ? fs.readFileSync(filename).toString('hex') : stat.isSymbolicLink() ? fs.readlinkSync(filename) : 'directory'];
    })
  };
}

function run(args = [], extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, SYNC_TOMBSTONE_RETENTION_DAYS: '90', PURGE_SYNC_TOMBSTONES: 'false', ...extraEnvironment },
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(result.error, undefined);
  return result;
}

function successfulRun(args = [], extraEnvironment = {}) {
  const result = run(args, extraEnvironment);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test.beforeEach(() => {
  for (const table of tables) database.exec(`DELETE FROM "${table}"`);
  fs.mkdirSync(uploadDir, { recursive: true });
  for (const name of fs.readdirSync(uploadDir)) {
    const filename = path.join(uploadDir, name);
    assert.equal(path.dirname(filename), uploadDir);
    fs.rmSync(filename, { recursive: true, force: true });
  }
  database.prepare('INSERT INTO User (id,email,passwordHash,updatedAt) VALUES (?,?,?,?)').run('owner', 'cleanup@example.test', 'unused', now);
  for (const name of ['current.mp3', 'historical.mp3', 'tombstone.mp3', 'receipt.mp3', 'orphan.mp3']) file(name);
  file('recent-registration.mp3', now);
  file('recent-mtime.mp3', old, now);
  database.prepare('INSERT INTO Song (id,userId,name,cloudUrl,dateAdded,updatedAt) VALUES (?,?,?,?,?,?)')
    .run('current-song', 'owner', 'Current', '/uploads/current.mp3', old, now);
  database.prepare('INSERT INTO Karaoke (id,userId,name,cloudUrl,dateAdded,updatedAt,deletedAt) VALUES (?,?,?,?,?,?,?)')
    .run('deleted-karaoke', 'owner', 'Deleted', '/uploads/tombstone.mp3', old, old, old);
  database.prepare('INSERT INTO SyncChange (userId,entityType,entityId,version,action,payload,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run('owner', 'song', 'current-song', 1, 'upsert', JSON.stringify({ entityType: 'song', entityId: 'current-song', data: { file: { url: '/uploads/historical.mp3' } } }), old);
  receipt('recent-receipt', now, { accepted: false, serverEntity: { data: { file: { url: '/uploads/receipt.mp3' } } } });
  receipt('expired-receipt', old, { accepted: true });
});

test.after(() => {
  database.close();
  environment.cleanup();
});

test('cleanup defaults to a non-mutating preview, including when tombstone purge is requested', () => {
  const before = state();
  const result = run([], { PURGE_SYNC_TOMBSTONES: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state(), before);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.fileCandidates, ['orphan.mp3']);
  assert.equal(report.expiredOperationReceipts, 1);
  assert.equal(report.tombstoneCandidates, 1);
  assert.equal(report.deletedFiles, 0);
});

test('explicit apply preserves current, historical, receipt and recently registered files', () => {
  const result = run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['current.mp3', 'historical.mp3', 'tombstone.mp3', 'receipt.mp3', 'recent-registration.mp3', 'recent-mtime.mp3']) {
    assert.equal(fs.existsSync(path.join(uploadDir, name)), true, name);
  }
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.mode, 'apply');
  assert.equal(report.deletedFiles, 1);
  assert.equal(fs.existsSync(path.join(uploadDir, 'orphan.mp3')), false);
  assert.equal(database.prepare("SELECT count(*) AS count FROM FileAsset WHERE cloudUrl='/uploads/orphan.mp3'").get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM SyncChange').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM ProcessedSyncOperation').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM Karaoke').get().count, 1);
  assert.equal(successfulRun(['--apply']).deletedFiles, 0);
});

test('explicit dry-run never mutates, and ambiguous or unknown flags fail before cleanup', () => {
  const before = state();
  successfulRun(['--dry-run']);
  assert.deepEqual(state(), before);
  for (const args of [['--apply', '--dry-run'], ['--unknown']]) {
    assert.notEqual(run(args).status, 0);
    assert.deepEqual(state(), before);
  }
});

test('malformed immutable snapshots abort cleanup before any database or file deletion', () => {
  for (const payload of ['{broken', 'null', '[]', JSON.stringify({ data: { file: { url: '/uploads/../outside' } } })]) {
    database.prepare('UPDATE SyncChange SET payload=?').run(payload);
    const before = state();
    assert.notEqual(run(['--apply']).status, 0);
    assert.deepEqual(state(), before);
  }
});

test('malformed retained operation results abort cleanup before mutation', () => {
  database.prepare("UPDATE ProcessedSyncOperation SET result='{broken' WHERE operationId='recent-receipt'").run();
  const before = state();
  assert.notEqual(run(['--apply']).status, 0);
  assert.deepEqual(state(), before);
});

test('references beyond the first history and receipt batches remain protected', () => {
  const change = database.prepare('INSERT INTO SyncChange (userId,entityType,entityId,version,action,payload,createdAt) VALUES (?,?,?,?,?,?,?)');
  for (let index = 0; index < 205; index++) {
    change.run('owner', 'song', 'current-song', index + 2, 'upsert', '{}', old);
    receipt(`batch-${index}`, now, { accepted: true });
  }
  file('late-history.mp3');
  file('late-receipt.mp3');
  change.run('owner', 'song', 'current-song', 207, 'upsert', JSON.stringify({ data: { file: { url: '/uploads/late-history.mp3' } } }), old);
  receipt('last-receipt', now, { serverEntity: { data: { file: { url: '/uploads/late-receipt.mp3' } } } });
  assert.deepEqual(successfulRun(['--apply']).fileCandidates, ['orphan.mp3']);
  assert.equal(fs.existsSync(path.join(uploadDir, 'late-history.mp3')), true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'late-receipt.mp3')), true);
});

test('database cleanup failure rolls back tombstones before any file removal', () => {
  database.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON ProcessedSyncOperation BEGIN SELECT RAISE(ABORT, 'Cleanup fixture failure'); END");
  try {
    const before = state();
    assert.notEqual(run(['--apply'], { PURGE_SYNC_TOMBSTONES: 'true' }).status, 0);
    assert.deepEqual(state(), before);
  } finally {
    database.exec('DROP TRIGGER reject_cleanup');
  }
});

test('legacy null snapshots and expired malformed receipts do not block cleanup', () => {
  database.prepare('UPDATE SyncChange SET payload=NULL').run();
  database.prepare("UPDATE ProcessedSyncOperation SET result='{broken' WHERE operationId='expired-receipt'").run();
  const report = successfulRun(['--apply']);
  assert.deepEqual(report.fileCandidates, ['historical.mp3', 'orphan.mp3']);
  assert.equal(report.deletedOperationReceipts, 1);
  assert.equal(fs.existsSync(path.join(uploadDir, 'receipt.mp3')), true);
  assert.equal(database.prepare('SELECT count(*) AS count FROM SyncChange').get().count, 1);
});

test('cleanup leaves symlinks, directories and their targets untouched', () => {
  const target = path.join(environment.testDir, 'outside-uploads.txt');
  fs.writeFileSync(target, 'Preserve external target');
  fs.symlinkSync(target, path.join(uploadDir, 'old-link.mp3'));
  fs.mkdirSync(path.join(uploadDir, 'old-directory'));
  fs.writeFileSync(path.join(uploadDir, 'old-directory', 'nested.mp3'), 'Preserve nested file');
  successfulRun(['--apply']);
  assert.equal(fs.lstatSync(path.join(uploadDir, 'old-link.mp3')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Preserve external target');
  assert.equal(fs.readFileSync(path.join(uploadDir, 'old-directory', 'nested.mp3'), 'utf8'), 'Preserve nested file');
});

test('explicit tombstone purge remains opt-in and does not remove retained sync history', () => {
  const report = successfulRun(['--apply'], { PURGE_SYNC_TOMBSTONES: 'true' });
  assert.equal(report.deletedTombstones, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM Karaoke').get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM SyncChange').get().count, 1);
  assert.equal(fs.existsSync(path.join(uploadDir, 'historical.mp3')), true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'tombstone.mp3')), true);
});

test('invalid retention settings fail before any cleanup and the minimum stays 30 days', () => {
  const before = state();
  for (const value of ['invalid', 'Infinity', '-1', '1.5', '9007199254740992']) {
    assert.notEqual(run(['--apply'], { SYNC_TOMBSTONE_RETENTION_DAYS: value }).status, 0);
    assert.deepEqual(state(), before);
  }
  const report = successfulRun([], { SYNC_TOMBSTONE_RETENTION_DAYS: '1' });
  assert.equal(report.retentionDays, 30);
  assert.deepEqual(state(), before);
});
