const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { databaseUrl } = require('../config/database');

const root = path.resolve(__dirname, '..');
const baseline = ['20260621012303_init_catalog', '20260810000000_add_sync_v2'];
const quote = name => `"${name.replaceAll('"', '""')}"`;
const sorted = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function schema(database) {
  const objects = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name").all();
  return objects.map(object => {
    if (object.type !== 'table' && object.type !== 'index') throw new Error('Unexpected schema object');
    if (object.type === 'index') return { type: object.type, name: object.name, sql: object.sql.replace(/\s+/g, '').toLowerCase() };
    const columns = sorted(database.prepare(`PRAGMA table_info(${quote(object.name)})`).all().map(({ cid, ...column }) => column));
    const keys = sorted(database.prepare(`PRAGMA foreign_key_list(${quote(object.name)})`).all().map(({ id, ...key }) => key));
    const indexes = sorted(database.prepare(`PRAGMA index_list(${quote(object.name)})`).all().map(index => ({
      unique: index.unique, origin: index.origin, partial: index.partial,
      columns: database.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().map(({ cid, ...column }) => column)
    })));
    // Keep constraints not exposed by table_info, while ignoring db-push column order.
    if (/\b(CHECK|COLLATE|STRICT|WITHOUT\s+ROWID|GENERATED|DEFERRABLE|ON\s+CONFLICT)\b/i.test(object.sql)) throw new Error('Unexpected table constraint');
    return { type: object.type, name: object.name, columns, keys, indexes, autoincrement: /\bAUTOINCREMENT\b/i.test(object.sql) };
  });
}

function checkIntegrity(database) {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('SQLite integrity check failed');
  if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key violations found');
}

function inspect(database) {
  checkIntegrity(database);
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='_prisma_migrations'").get()) {
    if (database.prepare('SELECT count(*) AS count FROM _prisma_migrations').get().count) {
      throw new Error('Migration history already exists; use db:status instead of adoption');
    }
  }
  const expected = new DatabaseSync(':memory:');
  try {
    for (const name of baseline) expected.exec(fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
    if (JSON.stringify(schema(database)) !== JSON.stringify(schema(expected))) {
      throw new Error('Schema does not exactly match the supported legacy sync-v2 database');
    }
  } finally {
    expected.close();
  }
  const counts = {};
  for (const table of ['User', 'CatalogTab', 'Song', 'Karaoke', 'CustomChord', 'Playlist', 'KaraokePlaylist', 'ProcessedSyncOperation']) {
    counts[table] = database.prepare(`SELECT count(*) AS count FROM ${quote(table)}`).get().count;
  }
  const repairs = {};
  for (const table of ['Song', 'Karaoke', 'CustomChord']) {
    const date = table === 'CustomChord' ? 'updatedAt' : 'dateAdded';
    const fileCondition = table === 'CustomChord' ? '' : " OR (cloudUrl IS NOT NULL AND cloudUrl<>'' AND fileVersion=0)";
    repairs[table] = database.prepare(`SELECT count(*) AS count FROM ${quote(table)} WHERE (createdAt=0 AND ${date}<>0)${fileCondition}`).get().count;
    if (database.prepare(`SELECT 1 FROM ${quote(table)} WHERE version<1 LIMIT 1`).get()) throw new Error('Invalid entity version');
  }
  for (const [table, field] of [['Playlist', 'songCloudIds'], ['KaraokePlaylist', 'karaokeCloudIds']]) {
    if (database.prepare(`SELECT 1 FROM ${quote(table)} WHERE NOT json_valid(${quote(field)}) OR json_type(${quote(field)})<>'array' LIMIT 1`).get()) {
      throw new Error('Invalid playlist memberships; manual review required');
    }
    if (database.prepare(`SELECT 1 FROM ${quote(table)} WHERE version<1 LIMIT 1`).get()) throw new Error('Invalid entity version');
  }
  return { baseline, counts, repairs };
}

function repairMetadata(database) {
  const { publicEntity } = require(path.join(process.env.RIFF_TEST_BUILD_DIR || path.join(root, 'dist'), 'services/syncService'));
  const now = Date.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, type] of [['Song', 'song'], ['Karaoke', 'karaoke'], ['CustomChord', 'custom_chord']]) {
      const date = table === 'CustomChord' ? 'updatedAt' : 'dateAdded';
      const fileCondition = table === 'CustomChord' ? '' : " OR (cloudUrl IS NOT NULL AND cloudUrl<>'' AND fileVersion=0)";
      const rows = database.prepare(`SELECT * FROM ${quote(table)} WHERE (createdAt=0 AND ${date}<>0)${fileCondition}`).all();
      for (const row of rows) {
        const fileUpdate = table === 'CustomChord' ? '' : ", fileVersion=CASE WHEN cloudUrl IS NOT NULL AND cloudUrl<>'' AND fileVersion=0 THEN 1 ELSE fileVersion END";
        database.prepare(`UPDATE ${quote(table)} SET createdAt=CASE WHEN createdAt=0 THEN ${date} ELSE createdAt END${fileUpdate}, version=version+1, updatedAt=? WHERE id=?`).run(now, row.id);
        const updated = database.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(row.id);
        updated.isPublic = Boolean(updated.isPublic);
        if (type === 'karaoke') updated.hasLocalAudio = Boolean(updated.hasLocalAudio);
        const payload = JSON.stringify(publicEntity(type, updated));
        database.prepare('INSERT INTO SyncChange (userId,entityType,entityId,version,action,payload,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(updated.userId, type, updated.id, updated.version, updated.deletedAt === null ? 'upsert' : 'delete', payload, now);
      }
    }
    for (const [table, type] of [['Song', 'song'], ['Karaoke', 'karaoke'], ['CustomChord', 'custom_chord'], ['Playlist', 'playlist'], ['KaraokePlaylist', 'karaoke_playlist']]) {
      const rows = database.prepare(`SELECT entity.* FROM ${quote(table)} entity WHERE NOT EXISTS (SELECT 1 FROM SyncChange c WHERE c.userId=entity.userId AND c.entityType=? AND c.entityId=entity.id)`).all(type);
      for (const row of rows) {
        row.isPublic = Boolean(row.isPublic);
        if (type === 'karaoke') row.hasLocalAudio = Boolean(row.hasLocalAudio);
        database.prepare('INSERT INTO SyncChange (userId,entityType,entityId,version,action,payload,createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(row.userId, type, row.id, row.version, row.deletedAt === null ? 'upsert' : 'delete', JSON.stringify(publicEntity(type, row)), now);
      }
    }
    checkIntegrity(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function prisma(filename, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/prisma.js'), 'migrate', ...args], {
    cwd: root, env: { ...process.env, DATABASE_URL: `file:${filename}` }, encoding: 'utf8'
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'Prisma failed');
}

function adopt(filename) {
  const database = new DatabaseSync(filename, { timeout: 10000 });
  let before;
  try {
    before = inspect(database);
    // Prisma 5 uses rollback journaling; refuse competing WAL connections before repairs.
    const journal = database.prepare('PRAGMA journal_mode=DELETE').get();
    if (Object.values(journal)[0] !== 'delete') throw new Error('Close all database connections before adoption');
    repairMetadata(database);
  } finally {
    database.close();
  }
  for (const name of baseline) prisma(filename, ['resolve', '--applied', name]);
  prisma(filename, ['deploy']);
  const verified = new DatabaseSync(filename, { readOnly: true });
  try {
    checkIntegrity(verified);
    for (const [table, count] of Object.entries(before.counts)) {
      if (verified.prepare(`SELECT count(*) AS count FROM ${quote(table)}`).get().count !== count) throw new Error('Entity counts changed during adoption');
    }
    const history = verified.prepare('SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name').all();
    const expected = fs.readdirSync(path.join(root, 'prisma/migrations')).filter(name => fs.existsSync(path.join(root, 'prisma/migrations', name, 'migration.sql'))).sort();
    if (JSON.stringify(history.map(row => row.migration_name)) !== JSON.stringify(expected) || history.some(row => !row.finished_at || row.rolled_back_at)) {
      throw new Error('Migration history verification failed');
    }
  } finally {
    verified.close();
  }
  return before;
}

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const backupIndex = args.indexOf('--backup');
  const backupPath = backupIndex >= 0 ? args[backupIndex + 1] : undefined;
  const allowed = new Set(['--apply', '--maintenance', '--backup', backupPath]);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Usage: db:adopt-legacy [--apply --maintenance --backup /absolute/new-backup.db]');
  if (apply && (!args.includes('--maintenance') || !backupPath || !path.isAbsolute(backupPath))) {
    throw new Error('Applying requires stopped writers, --maintenance and --backup with a new absolute filename');
  }
  const filename = databaseUrl.slice(5);
  const source = new DatabaseSync(filename, { readOnly: true, timeout: 10000 });
  let report;
  try {
    report = inspect(source);
    if (!apply) {
      console.log(JSON.stringify({ mode: 'read-only', ...report }, null, 2));
      return;
    }
    const descriptor = fs.openSync(backupPath, 'wx', 0o600);
    fs.closeSync(descriptor);
    await backup(source, backupPath);
    fs.chmodSync(backupPath, 0o600);
  } finally {
    source.close();
  }
  const rehearsalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-forge-adoption-'));
  try {
    const rehearsal = path.join(rehearsalDir, 'rehearsal.db');
    fs.copyFileSync(backupPath, rehearsal);
    fs.chmodSync(rehearsal, 0o600);
    adopt(rehearsal);
    console.log('Backup restored and adoption rehearsed successfully; adopting target database');
    adopt(filename);
    console.log(JSON.stringify({ mode: 'applied', backup: backupPath, ...report }, null, 2));
  } finally {
    fs.rmSync(rehearsalDir, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inspect, repairMetadata, main };
