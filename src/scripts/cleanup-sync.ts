import fs from 'fs';
import path from 'path';
import { prisma } from '../utils/prisma';
import { safeUploadPath } from '../services/fileMetadata';

const retentionDays = Math.max(30, Number(process.env.SYNC_TOMBSTONE_RETENTION_DAYS || 90));
const cutoff = BigInt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

async function main() {
  const files: string[] = [];
  await prisma.$transaction(async (tx: any) => {
    // Tombstones are intentionally retained indefinitely by default. Explicit
    // purging is only safe when every client is forced through a full resync.
    if (process.env.PURGE_SYNC_TOMBSTONES === 'true') {
      for (const name of ['song', 'karaoke']) {
        const rows = await tx[name].findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true, cloudUrl: true } });
        files.push(...rows.map((row: any) => row.cloudUrl).filter(Boolean));
        await tx[name].deleteMany({ where: { deletedAt: { lt: cutoff } } });
      }
      for (const name of ['playlist', 'karaokePlaylist', 'customChord']) await tx[name].deleteMany({ where: { deletedAt: { lt: cutoff } } });
    }
    await tx.processedSyncOperation.deleteMany({ where: { createdAt: { lt: cutoff } } });
  });
  for (const cloudUrl of files) {
    const filePath = safeUploadPath(cloudUrl);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  const referenced = new Set<string>();
  for (const name of ['song', 'karaoke']) {
    const rows = await (prisma as any)[name].findMany({ where: { cloudUrl: { not: null } }, select: { cloudUrl: true } });
    rows.forEach((row: any) => referenced.add(path.basename(row.cloudUrl)));
  }
  const uploadDir = path.join(__dirname, '../../uploads');
  if (fs.existsSync(uploadDir)) {
    for (const filename of fs.readdirSync(uploadDir)) {
      const filePath = path.join(uploadDir, filename);
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !referenced.has(filename) && BigInt(Math.floor(stat.mtimeMs)) < cutoff) fs.unlinkSync(filePath);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
