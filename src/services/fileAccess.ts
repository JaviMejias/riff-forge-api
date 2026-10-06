import { Prisma } from '@prisma/client';
import { HttpError } from './httpError';

type FileStore = Pick<Prisma.TransactionClient, 'fileAsset' | 'song' | 'karaoke'>;

export async function canReadFile(store: FileStore, cloudUrl: string, userId?: string): Promise<boolean> {
  const asset = await store.fileAsset.findUnique({ where: { cloudUrl } });
  let ownerId = asset?.userId;
  if (!ownerId) {
    const references = await Promise.all([
      store.song.findMany({ where: { cloudUrl }, select: { userId: true } }),
      store.karaoke.findMany({ where: { cloudUrl }, select: { userId: true } })
    ]);
    const owners = new Set(references.flat().map(reference => reference.userId));
    if (owners.size !== 1) return false;
    ownerId = owners.values().next().value!;
  }
  if (userId === ownerId) return true;
  const where = { cloudUrl, userId: ownerId, isPublic: true, deletedAt: null };
  const song = await store.song.findFirst({ where, select: { id: true } });
  if (song) return true;
  return !!await store.karaoke.findFirst({ where, select: { id: true } });
}

export function fileNotFound() {
  return new HttpError(404, 'Archivo no encontrado');
}
