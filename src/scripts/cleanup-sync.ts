import fs from 'fs';
import path from 'path';
import { prisma } from '../utils/prisma';
import { uploadDir } from '../utils/storage';
import { safeUploadPath } from '../services/fileMetadata';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(text: string, context: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid ${context}; cleanup aborted`); }
  if (!isRecord(value)) throw new Error(`Invalid ${context}; cleanup aborted`);
  return value;
}

function protectUrl(value: unknown, referenced: Set<string>) {
  if (value === null || value === undefined) return;
  const filePath = safeUploadPath(value);
  if (!filePath) throw new Error('Invalid retained file reference; cleanup aborted');
  referenced.add(path.basename(filePath));
}

function protectSnapshot(value: unknown, referenced: Set<string>) {
  if (value === null || value === undefined) return;
  if (!isRecord(value)) throw new Error('Invalid retained snapshot; cleanup aborted');
  const data = value.data;
  if (data === undefined) return;
  if (!isRecord(data)) throw new Error('Invalid retained snapshot data; cleanup aborted');
  const file = data.file;
  if (file === null || file === undefined) return;
  if (!isRecord(file) || typeof file.url !== 'string') throw new Error('Invalid retained snapshot file; cleanup aborted');
  protectUrl(file.url, referenced);
}

async function retainedFiles(cutoff: bigint) {
  const referenced = new Set<string>();
  const current = await Promise.all([
    prisma.song.findMany({ where: { cloudUrl: { not: null } }, select: { cloudUrl: true } }),
    prisma.karaoke.findMany({ where: { cloudUrl: { not: null } }, select: { cloudUrl: true } }),
    prisma.fileAsset.findMany({ where: { createdAt: { gte: cutoff } }, select: { cloudUrl: true } })
  ]);
  for (const rows of current) for (const row of rows) protectUrl(row.cloudUrl, referenced);

  // Bound scans at their initial high-water marks instead of chasing new writes forever.
  const lastChange = await prisma.syncChange.findFirst({ orderBy: { sequence: 'desc' }, select: { sequence: true } });
  let sequence = 0;
  while (sequence < (lastChange?.sequence ?? 0)) {
    const rows = await prisma.syncChange.findMany({
      where: { sequence: { gt: sequence, lte: lastChange!.sequence } },
      orderBy: { sequence: 'asc' }, take: 200, select: { sequence: true, payload: true }
    });
    if (!rows.length) break;
    for (const row of rows) {
      if (row.payload !== null) protectSnapshot(parseRecord(row.payload, `sync change ${row.sequence}`), referenced);
    }
    sequence = rows[rows.length - 1].sequence;
  }

  const lastReceipt = await prisma.processedSyncOperation.findFirst({
    where: { createdAt: { gte: cutoff } }, orderBy: { id: 'desc' }, select: { id: true }
  });
  let receiptId = 0;
  while (receiptId < (lastReceipt?.id ?? 0)) {
    const rows = await prisma.processedSyncOperation.findMany({
      where: { createdAt: { gte: cutoff }, id: { gt: receiptId, lte: lastReceipt!.id } },
      orderBy: { id: 'asc' }, take: 200, select: { id: true, result: true }
    });
    if (!rows.length) break;
    for (const row of rows) protectSnapshot(parseRecord(row.result, `operation receipt ${row.id}`).serverEntity, referenced);
    receiptId = rows[rows.length - 1].id;
  }
  return referenced;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--dry-run') || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Use --dry-run (default) or --apply, not both');
  }
  const requestedDays = Number(process.env.SYNC_TOMBSTONE_RETENTION_DAYS || 90);
  if (!Number.isSafeInteger(requestedDays) || requestedDays < 0) throw new Error('Invalid retention days');
  const retentionDays = Math.max(30, requestedDays);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoffTime)) throw new Error('Invalid retention cutoff');
  const cutoff = BigInt(cutoffTime);
  const apply = args.includes('--apply');
  const purgeTombstones = process.env.PURGE_SYNC_TOMBSTONES === 'true';
  const referenced = await retainedFiles(cutoff);
  const fileCandidates: string[] = [];
  if (fs.existsSync(uploadDir)) {
    for (const filename of fs.readdirSync(uploadDir).sort()) {
      const stat = fs.lstatSync(path.join(uploadDir, filename));
      if (safeUploadPath(`/uploads/${filename}`) && stat.isFile() && !referenced.has(filename) && stat.mtimeMs < cutoffTime) {
        fileCandidates.push(filename);
      }
    }
  }
  const expiredOperationReceipts = await prisma.processedSyncOperation.count({ where: { createdAt: { lt: cutoff } } });
  const tombstoneWhere = { deletedAt: { lt: cutoff } };
  const tombstoneCandidates = purgeTombstones ? (await Promise.all([
    prisma.song.count({ where: tombstoneWhere }), prisma.karaoke.count({ where: tombstoneWhere }),
    prisma.playlist.count({ where: tombstoneWhere }), prisma.karaokePlaylist.count({ where: tombstoneWhere }),
    prisma.customChord.count({ where: tombstoneWhere })
  ])).reduce((total, count) => total + count, 0) : 0;
  let deletedOperationReceipts = 0;
  let deletedTombstones = 0;
  let deletedFiles = 0;
  if (apply) {
    await prisma.$transaction(async tx => {
      // Physical tombstone purge still requires an external mandatory full-resync policy.
      if (purgeTombstones) {
        const deleted = await Promise.all([
          tx.song.deleteMany({ where: tombstoneWhere }), tx.karaoke.deleteMany({ where: tombstoneWhere }),
          tx.playlist.deleteMany({ where: tombstoneWhere }), tx.karaokePlaylist.deleteMany({ where: tombstoneWhere }),
          tx.customChord.deleteMany({ where: tombstoneWhere })
        ]);
        deletedTombstones = deleted.reduce((total, result) => total + result.count, 0);
      }
      deletedOperationReceipts = (await tx.processedSyncOperation.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
    });
    for (const filename of fileCandidates) {
      const filePath = safeUploadPath(`/uploads/${filename}`)!;
      const stat = await fs.promises.lstat(filePath).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat?.isFile() || stat.mtimeMs >= cutoffTime) continue;
      await fs.promises.unlink(filePath);
      await prisma.fileAsset.deleteMany({ where: { cloudUrl: `/uploads/${filename}` } });
      deletedFiles++;
    }
  }
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', retentionDays, cutoff: cutoff.toString(),
    fileCandidates, expiredOperationReceipts, tombstoneCandidates,
    deletedFiles, deletedOperationReceipts, deletedTombstones
  }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
