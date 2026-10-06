import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { recordChange } from '../services/syncService';
import { HttpError } from '../services/httpError';
import { assertCollectionVersion, assertItemVersion, collectionVersion, updateVersioned } from '../services/versionedWrites';
import { validateMetadata, isTimestamp, invalidInput } from '../services/inputValidation';
import { normalizeChordArrays } from '../services/chordData';
import { recordRequestError } from '../middleware/requestDiagnostics';

const serialize = (value: any) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const asBoolean = (value: unknown) => value === true || value === 'true';

function validateItems(items: unknown, chords = false) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Se esperaba una colección');
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name.trim()) {
      throw new HttpError(400, 'Registro inválido', { code: 'validation_error' });
    }
    if (ids.has(item.id)) throw new HttpError(400, 'Identificador duplicado', { code: 'duplicate_id' });
    ids.add(item.id);
    validateMetadata(chords ? 'custom_chord' : 'playlist', item, false, true);
    if (!chords && item.createdAt !== undefined && !isTimestamp(item.createdAt)) invalidInput('createdAt');
    if (chords && (typeof item.root !== 'string' || !Number.isInteger(Number(item.baseFret)))) {
      throw new HttpError(400, 'Acorde inválido', { code: 'validation_error' });
    }
  }
}

async function ownedIds(tx: any, userId: string, modelName: 'song' | 'karaoke', ids: unknown) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('invalid_references');
  const unique = Array.from(new Set(ids as string[]));
  const rows = await tx[modelName].findMany({ where: { userId, id: { in: unique }, deletedAt: null }, select: { id: true } });
  if (rows.length !== unique.length) throw new Error('invalid_references');
  return ids as string[];
}

export const getPlaylists = async (req: Request, res: Response) => {
  try {
    const playlists = await prisma.playlist.findMany({ where: { userId: req.userId } });
    res.set('X-Collection-Version', collectionVersion(req.userId, 'playlist', playlists));
    const mapped = await Promise.all(playlists.filter(playlist => playlist.deletedAt === null).map(async (playlist: any) => {
      const songCloudIds: string[] = JSON.parse(playlist.songCloudIds || '[]');
      const rows = await prisma.song.findMany({ where: { userId: req.userId, id: { in: songCloudIds }, deletedAt: null } });
      const byId = new Map(rows.map(song => [song.id, song]));
      return { ...playlist, songCloudIds: songCloudIds.filter(id => byId.has(id)), songs: songCloudIds.map(id => byId.get(id)).filter(Boolean) };
    }));
    res.json(serialize(mapped));
  } catch (error) {
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
};

export const savePlaylists = async (req: Request, res: Response, next: NextFunction) => saveCollection(req, res, next, 'playlist');

export const getKaraokePlaylists = async (req: Request, res: Response) => {
  try {
    const playlists = await prisma.karaokePlaylist.findMany({ where: { userId: req.userId } });
    res.set('X-Collection-Version', collectionVersion(req.userId, 'karaoke_playlist', playlists));
    const mapped = await Promise.all(playlists.filter(playlist => playlist.deletedAt === null).map(async (playlist: any) => {
      const karaokeCloudIds: string[] = JSON.parse(playlist.karaokeCloudIds || '[]');
      const rows = await prisma.karaoke.findMany({ where: { userId: req.userId, id: { in: karaokeCloudIds }, deletedAt: null } });
      const byId = new Map(rows.map(karaoke => [karaoke.id, karaoke]));
      return { ...playlist, karaokeCloudIds: karaokeCloudIds.filter(id => byId.has(id)), karaokes: karaokeCloudIds.map(id => byId.get(id)).filter(Boolean) };
    }));
    res.json(serialize(mapped));
  } catch (error) {
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to fetch karaoke playlists' });
  }
};

export const saveKaraokePlaylists = async (req: Request, res: Response, next: NextFunction) => saveCollection(req, res, next, 'karaokePlaylist');

async function saveCollection(req: Request, res: Response, next: NextFunction, kind: 'playlist' | 'karaokePlaylist') {
  const userId = req.userId!;
  if (!Array.isArray(req.body)) return res.status(400).json({ error: `Expected an array of ${kind}s` });
  try {
    validateItems(req.body);
    const etag = await prisma.$transaction(async (tx: any) => {
      const now = Date.now();
      const entityType = kind === 'playlist' ? 'playlist' : 'karaoke_playlist';
      const ids = req.body.map((item: any) => item.id);
      const existing = await tx[kind].findMany({ where: { userId } });
      assertCollectionVersion(req, userId, entityType, existing);
      for (const old of existing) {
        if (!ids.includes(old.id) && old.deletedAt === null) {
          const deleted = await updateVersioned(tx, entityType, old, { deletedAt: BigInt(now), updatedAt: BigInt(now), isPublic: false });
          await recordChange(tx, userId, entityType, old.id, deleted.version, 'delete', now);
        }
      }
      for (const item of req.body) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('validation_error');
        const old = existing.find((entry: any) => entry.id === item.id);
        if (old) assertItemVersion(item, entityType, old);
        if (!old && await tx[kind].findUnique({ where: { id: item.id }, select: { id: true } })) throw new HttpError(404, 'Registro no encontrado');
        const listField = kind === 'playlist' ? 'songCloudIds' : 'karaokeCloudIds';
        const refs = await ownedIds(tx, userId, kind === 'playlist' ? 'song' : 'karaoke', item[listField] === undefined ? [] : item[listField]);
        const data: any = { name: item.name, [listField]: JSON.stringify(refs), isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
        const saved = old ? await updateVersioned(tx, entityType, old, data) : await tx[kind].create({ data: { ...data, id: item.id, userId, createdAt: BigInt(item.createdAt ?? now) } });
        await recordChange(tx, userId, entityType, item.id, saved.version, 'upsert', now);
      }
      return collectionVersion(userId, entityType, await tx[kind].findMany({ where: { userId } }));
    });
    res.set('X-Collection-Version', etag);
    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof HttpError) return next(error);
    if (['validation_error', 'invalid_references'].includes(error.message)) return next(new HttpError(400, 'Datos o referencias inválidos'));
    next(error);
  }
}

export const getCustomChords = async (req: Request, res: Response) => {
  try {
    const chords = await prisma.customChord.findMany({ where: { userId: req.userId } });
    res.set('X-Collection-Version', collectionVersion(req.userId, 'custom_chord', chords));
    res.json(serialize(chords.filter(chord => chord.deletedAt === null)));
  } catch (error) {
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to fetch chords' });
  }
};

export const saveCustomChords = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.userId!;
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array of chords' });
  try {
    validateItems(req.body, true);
    const etag = await prisma.$transaction(async (tx: any) => {
      const now = Date.now();
      const ids = req.body.map((item: any) => item.id);
      const existing = await tx.customChord.findMany({ where: { userId } });
      assertCollectionVersion(req, userId, 'custom_chord', existing);
      for (const old of existing) {
        if (!ids.includes(old.id) && old.deletedAt === null) {
          const deleted = await updateVersioned(tx, 'custom_chord', old, { deletedAt: BigInt(now), updatedAt: BigInt(now), isPublic: false });
          await recordChange(tx, userId, 'custom_chord', old.id, deleted.version, 'delete', now);
        }
      }
      for (const item of req.body) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.root !== 'string' || !Number.isInteger(Number(item.baseFret))) throw new Error('validation_error');
        const old = existing.find((entry: any) => entry.id === item.id);
        if (old) assertItemVersion(item, 'custom_chord', old);
        if (!old && await tx.customChord.findUnique({ where: { id: item.id }, select: { id: true } })) throw new HttpError(404, 'Registro no encontrado');
        const arrays = normalizeChordArrays({ frets: [], fingers: [], barres: [], ...item });
        const data = { name: item.name, root: item.root, frets: arrays.frets!, fingers: arrays.fingers!, baseFret: Number(item.baseFret), barres: arrays.barres, isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
        const saved = old ? await updateVersioned(tx, 'custom_chord', old, data) : await tx.customChord.create({ data: { ...data, id: item.id, userId, createdAt: BigInt(now) } });
        await recordChange(tx, userId, 'custom_chord', item.id, saved.version, 'upsert', now);
      }
      return collectionVersion(userId, 'custom_chord', await tx.customChord.findMany({ where: { userId } }));
    });
    res.set('X-Collection-Version', etag);
    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof HttpError) return next(error);
    if (error.message === 'validation_error') return next(new HttpError(400, 'Acorde inválido'));
    next(error);
  }
};
