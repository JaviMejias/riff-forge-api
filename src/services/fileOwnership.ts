import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { safeUploadPath } from './fileMetadata';
import { HttpError } from './httpError';
import { uploadDir } from '../utils/storage';

type FileStore = Pick<Prisma.TransactionClient, 'fileAsset' | 'song' | 'karaoke'>;

export async function registerFile(store: FileStore, userId: string, cloudUrl: string) {
  if (!safeUploadPath(cloudUrl)) throw new HttpError(400, 'Ruta de archivo inválida');
  return store.fileAsset.create({ data: { cloudUrl, userId, createdAt: BigInt(Date.now()) } });
}

async function findFileOwner(store: FileStore, cloudUrl: string) {
  const asset = await store.fileAsset.findUnique({ where: { cloudUrl } });
  if (asset) return asset;
  const references = await Promise.all([
    store.song.findMany({ where: { cloudUrl }, select: { userId: true } }),
    store.karaoke.findMany({ where: { cloudUrl }, select: { userId: true } })
  ]);
  const owners = new Set(references.flat().map(reference => reference.userId));
  if (owners.size !== 1) throw new HttpError(404, 'Archivo no encontrado');
  const ownerId = owners.values().next().value!;
  try {
    return await registerFile(store, ownerId, cloudUrl);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const registered = await store.fileAsset.findUnique({ where: { cloudUrl } });
    if (!registered) throw error;
    return registered;
  }
}

export async function requireOwnedFile(store: FileStore, userId: string, cloudUrl: unknown) {
  const filePath = safeUploadPath(cloudUrl);
  if (!filePath) throw new HttpError(400, 'Ruta de archivo inválida');
  const asset = await findFileOwner(store, cloudUrl as string);
  if (!asset || asset.userId !== userId) throw new HttpError(404, 'Archivo no encontrado');
  return filePath;
}

export async function discardPendingCopies(cloudUrls: ReadonlySet<string>) {
  await Promise.all([...cloudUrls].map(async cloudUrl => {
    const copyPath = safeUploadPath(cloudUrl);
    if (copyPath) await fs.promises.unlink(copyPath).catch(() => {});
  }));
}

export async function resolveFileReference(store: FileStore, userId: string, cloudUrl: unknown, pendingCopies: Set<string>) {
  if (cloudUrl === undefined || cloudUrl === null || cloudUrl === '') return null;
  const filePath = safeUploadPath(cloudUrl);
  if (!filePath) throw new HttpError(400, 'Ruta de archivo inválida');
  const asset = await findFileOwner(store, cloudUrl as string);
  if (asset?.userId === userId) return cloudUrl as string;

  const where = { cloudUrl: cloudUrl as string, userId: asset.userId, isPublic: true, deletedAt: null };
  const publicSong = await store.song.findFirst({ where, select: { id: true } });
  const publicKaraoke = publicSong ? null : await store.karaoke.findFirst({ where, select: { id: true } });
  if (!publicSong && !publicKaraoke) throw new HttpError(404, 'Archivo no encontrado');

  const filename = `${crypto.randomUUID()}${path.extname(filePath)}`;
  const copyPath = path.join(uploadDir, filename);
  const copyUrl = `/uploads/${filename}`;
  try {
    await fs.promises.copyFile(filePath, copyPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    // An exclusive-copy collision means this request did not create the destination.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      await fs.promises.unlink(copyPath).catch(() => {});
    }
    throw error;
  }
  // The caller compensates filesystem copies if a later database write rolls back.
  pendingCopies.add(copyUrl);
  await registerFile(store, userId, copyUrl);
  return copyUrl;
}
