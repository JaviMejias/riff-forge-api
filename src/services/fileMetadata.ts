import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function safeUploadPath(cloudUrl: unknown): string | null {
  if (typeof cloudUrl !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(cloudUrl)) return null;
  return path.join(__dirname, '../../uploads', path.basename(cloudUrl));
}

export function fileMetadata(cloudUrl: unknown, mimeType?: string) {
  const filePath = safeUploadPath(cloudUrl);
  if (!filePath || !fs.existsSync(filePath)) return { fileHash: null, fileSize: null, fileMimeType: mimeType || null };
  const contents = fs.readFileSync(filePath);
  return { fileHash: crypto.createHash('sha256').update(contents).digest('hex'), fileSize: BigInt(contents.length), fileMimeType: mimeType || null };
}
