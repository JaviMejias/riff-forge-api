"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const prisma_1 = require("../utils/prisma");
const fileMetadata_1 = require("../services/fileMetadata");
const retentionDays = Math.max(30, Number(process.env.SYNC_TOMBSTONE_RETENTION_DAYS || 90));
const cutoff = BigInt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
async function main() {
    const files = [];
    await prisma_1.prisma.$transaction(async (tx) => {
        // Tombstones are intentionally retained indefinitely by default. Explicit
        // purging is only safe when every client is forced through a full resync.
        if (process.env.PURGE_SYNC_TOMBSTONES === 'true') {
            for (const name of ['song', 'karaoke']) {
                const rows = await tx[name].findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true, cloudUrl: true } });
                files.push(...rows.map((row) => row.cloudUrl).filter(Boolean));
                await tx[name].deleteMany({ where: { deletedAt: { lt: cutoff } } });
            }
            for (const name of ['playlist', 'karaokePlaylist', 'customChord'])
                await tx[name].deleteMany({ where: { deletedAt: { lt: cutoff } } });
        }
        await tx.processedSyncOperation.deleteMany({ where: { createdAt: { lt: cutoff } } });
    });
    for (const cloudUrl of files) {
        const filePath = (0, fileMetadata_1.safeUploadPath)(cloudUrl);
        if (filePath && fs_1.default.existsSync(filePath))
            fs_1.default.unlinkSync(filePath);
    }
    const referenced = new Set();
    for (const name of ['song', 'karaoke']) {
        const rows = await prisma_1.prisma[name].findMany({ where: { cloudUrl: { not: null } }, select: { cloudUrl: true } });
        rows.forEach((row) => referenced.add(path_1.default.basename(row.cloudUrl)));
    }
    const uploadDir = path_1.default.join(__dirname, '../../uploads');
    if (fs_1.default.existsSync(uploadDir)) {
        for (const filename of fs_1.default.readdirSync(uploadDir)) {
            const filePath = path_1.default.join(uploadDir, filename);
            const stat = fs_1.default.lstatSync(filePath);
            if (stat.isFile() && !referenced.has(filename) && BigInt(Math.floor(stat.mtimeMs)) < cutoff)
                fs_1.default.unlinkSync(filePath);
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma_1.prisma.$disconnect());
