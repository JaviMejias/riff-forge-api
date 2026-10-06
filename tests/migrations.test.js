const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const migrations = fs.readdirSync(path.join(root, 'prisma/migrations'))
  .filter(name => fs.existsSync(path.join(root, 'prisma/migrations', name, 'migration.sql'))).sort();
let testDir;
let schemaDir;
let database;
let env;

function deploy() {
  return execFileSync(process.execPath, [
    path.join(root, 'scripts/prisma.js'), 'migrate', 'deploy',
    '--schema', path.join(schemaDir, 'schema.prisma')
  ], { cwd: root, env, stdio: 'pipe' });
}

function includeMigration(name) {
  fs.cpSync(path.join(root, 'prisma/migrations', name), path.join(schemaDir, 'migrations', name), { recursive: true });
}

test.before(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-forge-migrations-'));
  schemaDir = path.join(testDir, 'prisma');
  fs.mkdirSync(path.join(schemaDir, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(schemaDir, 'schema.prisma'));
  fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(schemaDir, 'migrations/migration_lock.toml'));
  env = { ...process.env, DATABASE_URL: `file:${path.join(testDir, 'test.db')}` };
  includeMigration(migrations[0]);
  deploy();
  database = new DatabaseSync(path.join(testDir, 'test.db'));
  database.exec("PRAGMA foreign_keys = ON");
  const user = database.prepare('INSERT INTO User (id, email, passwordHash, updatedAt) VALUES (?, ?, ?, ?)');
  user.run('owner', 'owner@example.test', 'unused', 1);
  user.run('foreign', 'foreign@example.test', 'unused', 1);
  const song = database.prepare('INSERT INTO Song (id, userId, name, dateAdded, updatedAt) VALUES (?, ?, ?, ?, ?)');
  for (const id of ['s-a', 's-b', 'song"quote', 's-collision', 's-deleted']) song.run(id, 'owner', id, 1, 1);
  song.run('s-foreign', 'foreign', 'Foreign', 1, 1);
  const playlist = database.prepare('INSERT INTO Playlist (id, userId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
  for (const id of ['p-legacy', 'p-modern', 'p-ordered', 'p-cleared', 'p-deleted', 'p-no-history', 's-collision', 'p-another']) {
    playlist.run(id, 'owner', id, 1, 1);
  }
  const relation = database.prepare('INSERT INTO _PlaylistToSong (A, B) VALUES (?, ?)');
  for (const id of ['p-legacy', 'p-modern', 'p-ordered', 'p-cleared', 'p-deleted', 'p-no-history', 's-collision']) {
    relation.run(id, 's-a');
  }
  relation.run('p-legacy', 's-b');
  relation.run('p-legacy', 'song"quote');
  relation.run('p-legacy', 's-foreign');
  relation.run('p-legacy', 's-deleted');
  relation.run('p-another', 's-collision');
  database.exec(`INSERT INTO Karaoke (id,userId,name,dateAdded,updatedAt) VALUES ('k-a','owner','Karaoke',1,1);
    INSERT INTO KaraokePlaylist (id,userId,name,createdAt,updatedAt) VALUES ('kp-a','owner','Karaoke playlist',1,1);
    INSERT INTO _KaraokePlaylistToKaraoke (A,B) VALUES ('k-a','kp-a');`);
  includeMigration(migrations[1]);
  deploy();
  assert.equal(database.prepare("SELECT songCloudIds FROM Playlist WHERE id='p-legacy'").get().songCloudIds, '[]');
  assert.equal(database.prepare("SELECT songCloudIds FROM Playlist WHERE id='s-collision'").get().songCloudIds, '["p-another"]');
  database.exec(`UPDATE Playlist SET version=2 WHERE id='p-modern';
    UPDATE Song SET deletedAt=2 WHERE id='s-deleted';
    UPDATE Playlist SET songCloudIds='["s-b","s-a"]' WHERE id='p-ordered';
    UPDATE SyncChange SET payload='{}' WHERE entityType='playlist' AND entityId='p-cleared';
    UPDATE Playlist SET deletedAt=2 WHERE id='p-deleted';
    DELETE FROM SyncChange WHERE entityType='playlist' AND entityId='p-no-history';`);
  for (const name of migrations.slice(2)) includeMigration(name);
  deploy();
});

test.after(() => {
  if (database) database.close();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

test('migration repairs the reversed relation and excludes songs belonging to another user', () => {
  const playlist = database.prepare("SELECT * FROM Playlist WHERE id='p-legacy'").get();
  assert.deepEqual(JSON.parse(playlist.songCloudIds), ['s-a', 's-b', 'song"quote']);
  assert.equal(playlist.version, 2);
  assert.ok(playlist.updatedAt > 1);
  const collision = database.prepare("SELECT songCloudIds, version FROM Playlist WHERE id='s-collision'").get();
  assert.deepEqual(JSON.parse(collision.songCloudIds), ['s-a']);
  assert.equal(collision.version, 2);
});

test('migration preserves edited, reordered, deliberately cleared and deleted playlists', () => {
  for (const id of ['p-modern', 'p-cleared', 'p-deleted', 'p-no-history']) {
    const playlist = database.prepare('SELECT * FROM Playlist WHERE id=?').get(id);
    assert.equal(playlist.songCloudIds, '[]');
    assert.equal(playlist.version, id === 'p-modern' ? 2 : 1);
  }
  const ordered = database.prepare("SELECT * FROM Playlist WHERE id='p-ordered'").get();
  assert.equal(ordered.songCloudIds, '["s-b","s-a"]');
  assert.equal(ordered.version, 1);
  assert.equal(database.prepare("SELECT deletedAt FROM Playlist WHERE id='p-deleted'").get().deletedAt, 2);
});

test('repair emits an immutable sync snapshot compatible with the API contract', () => {
  const change = database.prepare("SELECT * FROM SyncChange WHERE entityType='playlist' AND entityId='p-legacy' ORDER BY sequence DESC LIMIT 1").get();
  const payload = JSON.parse(change.payload);
  assert.equal(change.version, 2);
  assert.equal(change.action, 'upsert');
  assert.equal(payload.entityId, 'p-legacy');
  assert.equal(payload.version, 2);
  assert.equal(payload.deletedAt, null);
  assert.equal(payload.data.isPublic, false);
  assert.deepEqual(payload.data.songCloudIds, ['s-a', 's-b', 'song"quote']);
  database.exec("UPDATE Playlist SET name='Later edit' WHERE id='p-legacy'");
  assert.equal(JSON.parse(database.prepare('SELECT payload FROM SyncChange WHERE sequence=?').get(change.sequence).payload).data.name, 'p-legacy');
});

test('karaoke playlists keep their already correct legacy relation', () => {
  const playlist = database.prepare("SELECT * FROM KaraokePlaylist WHERE id='kp-a'").get();
  assert.equal(playlist.karaokeCloudIds, '["k-a"]');
  assert.equal(playlist.version, 1);
});

test('Prisma records migration checksums and a second deploy makes no data changes', () => {
  const history = database.prepare('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name').all();
  assert.deepEqual(history.map(row => row.migration_name), migrations);
  assert.ok(history.every(row => row.finished_at && row.rolled_back_at === null));
  const before = database.prepare('SELECT * FROM Playlist ORDER BY id').all();
  const events = database.prepare('SELECT * FROM SyncChange ORDER BY sequence').all();
  deploy();
  assert.deepEqual(database.prepare('SELECT * FROM Playlist ORDER BY id').all(), before);
  assert.deepEqual(database.prepare('SELECT * FROM SyncChange ORDER BY sequence').all(), events);
});

test('CLI refuses to run historical migrations on an unbaselined database', () => {
  const filename = path.join(testDir, 'unbaselined.db');
  const existing = new DatabaseSync(filename);
  existing.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('preserved');");
  existing.close();
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/prisma.js'), 'migrate', 'deploy', '--schema', path.join(schemaDir, 'schema.prisma')
  ], { cwd: root, env: { ...env, DATABASE_URL: `file:${filename}` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /P3005/);
  const checked = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(checked.prepare('SELECT id FROM User').get().id, 'preserved');
    assert.equal(checked.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='Song'").get().count, 0);
  } finally {
    checked.close();
  }
});

test('CLI and runtime resolve the same database independently of the working directory', () => {
  const config = require('../config/database');
  assert.equal(config.resolveDatabaseUrl(undefined, '/project'), 'file:/project/data/dev.db');
  assert.equal(config.resolveDatabaseUrl('file:../data/dev.db', '/project'), 'file:/project/data/dev.db');
  assert.equal(config.resolveDatabaseUrl('file:local.db', '/project'), 'file:/project/prisma/local.db');
  assert.equal(config.resolveDatabaseUrl('file:/elsewhere/custom.db', '/project'), 'file:/elsewhere/custom.db');
  assert.throws(() => config.resolveDatabaseUrl('postgresql://localhost/db'), /SQLite/);
  assert.throws(() => config.resolveDatabaseUrl('file:'), /SQLite/);
  const script = `const { prisma } = require(${JSON.stringify(path.join(process.env.RIFF_TEST_BUILD_DIR, 'utils/prisma'))}); prisma.$queryRawUnsafe('PRAGMA database_list').then(rows => console.log(rows.find(row => row.name === 'main').file)).finally(() => prisma.$disconnect());`;
  const runtimeUrl = execFileSync(process.execPath, ['-e', script], {
    cwd: testDir, env, encoding: 'utf8'
  }).trim();
  assert.equal(runtimeUrl, env.DATABASE_URL.slice(5));
});

test('build and start scripts do not push or migrate the database', () => {
  const scripts = require('../package.json').scripts;
  assert.equal(scripts.start, 'node dist/index.js');
  assert.equal(scripts.build, 'npm run prisma:generate && tsc');
  assert.equal(scripts['db:migrate'], 'node scripts/prisma.js migrate deploy');
});

test('production build compiles successfully without creating a SQLite database', () => {
  const projectDir = path.join(testDir, 'build-project');
  fs.mkdirSync(projectDir);
  for (const filename of ['config', 'scripts', 'src', 'prisma', 'package.json', 'tsconfig.json']) {
    fs.cpSync(path.join(root, filename), path.join(projectDir, filename), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(projectDir, 'node_modules'), 'dir');
  const databaseFile = path.join(projectDir, 'data/build.db');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run this test through npm test');
  execFileSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: projectDir, env: { ...env, DATABASE_URL: `file:${databaseFile}` }, stdio: 'pipe'
  });
  assert.ok(fs.existsSync(path.join(projectDir, 'dist/index.js')));
  assert.equal(fs.existsSync(databaseFile), false);
  assert.equal(fs.existsSync(path.dirname(databaseFile)), false);
});
