import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { recordChange } from '../services/syncService';

const serialize = (value: any) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const asBoolean = (value: unknown) => value === true || value === 'true';
const asJson = (value: unknown, fallback: unknown[] = []) => typeof value === 'string' ? value : JSON.stringify(value || fallback);

async function ownedIds(tx: any, userId: string, modelName: 'song' | 'karaoke', ids: unknown) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('invalid_references');
  const unique = Array.from(new Set(ids as string[]));
  const rows = await tx[modelName].findMany({ where: { userId, id: { in: unique }, deletedAt: null }, select: { id: true } });
  if (rows.length !== unique.length) throw new Error('invalid_references');
  return ids as string[];
}

export const getPlaylists = async (req: Request, res: Response) => {
  try {
    const playlists = await prisma.playlist.findMany({ where: { userId: req.userId, deletedAt: null } });
    const mapped = await Promise.all(playlists.map(async (playlist: any) => {
      const songCloudIds: string[] = JSON.parse(playlist.songCloudIds || '[]');
      const rows = await prisma.song.findMany({ where: { userId: req.userId, id: { in: songCloudIds }, deletedAt: null } });
      const byId = new Map(rows.map(song => [song.id, song]));
      return { ...playlist, songCloudIds: songCloudIds.filter(id => byId.has(id)), songs: songCloudIds.map(id => byId.get(id)).filter(Boolean) };
    }));
    res.json(serialize(mapped));
  } catch (_) { res.status(500).json({ error: 'Failed to fetch playlists' }); }
};

export const savePlaylists = async (req: Request, res: Response) => saveCollection(req, res, 'playlist');

export const getKaraokePlaylists = async (req: Request, res: Response) => {
  try {
    const playlists = await prisma.karaokePlaylist.findMany({ where: { userId: req.userId, deletedAt: null } });
    const mapped = await Promise.all(playlists.map(async (playlist: any) => {
      const karaokeCloudIds: string[] = JSON.parse(playlist.karaokeCloudIds || '[]');
      const rows = await prisma.karaoke.findMany({ where: { userId: req.userId, id: { in: karaokeCloudIds }, deletedAt: null } });
      const byId = new Map(rows.map(karaoke => [karaoke.id, karaoke]));
      return { ...playlist, karaokeCloudIds: karaokeCloudIds.filter(id => byId.has(id)), karaokes: karaokeCloudIds.map(id => byId.get(id)).filter(Boolean) };
    }));
    res.json(serialize(mapped));
  } catch (_) { res.status(500).json({ error: 'Failed to fetch karaoke playlists' }); }
};

export const saveKaraokePlaylists = async (req: Request, res: Response) => saveCollection(req, res, 'karaokePlaylist');

async function saveCollection(req: Request, res: Response, kind: 'playlist' | 'karaokePlaylist') {
  const userId = req.userId!;
  if (!Array.isArray(req.body)) return res.status(400).json({ error: `Expected an array of ${kind}s` });
  try {
    await prisma.$transaction(async (tx: any) => {
      const now = Date.now();
      const entityType = kind === 'playlist' ? 'playlist' : 'karaoke_playlist';
      const ids = req.body.map((item: any) => item.id);
      const existing = await tx[kind].findMany({ where: { userId } });
      for (const old of existing) {
        if (!ids.includes(old.id) && old.deletedAt === null) {
          const deleted = await tx[kind].update({ where: { id: old.id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: old.version + 1, isPublic: false } });
          await recordChange(tx, userId, entityType, old.id, deleted.version, 'delete', now);
        }
      }
      for (const item of req.body) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('validation_error');
        const old = existing.find((entry: any) => entry.id === item.id);
        if (old && old.deletedAt !== null) throw new Error('deleted_conflict');
        const listField = kind === 'playlist' ? 'songCloudIds' : 'karaokeCloudIds';
        const refs = await ownedIds(tx, userId, kind === 'playlist' ? 'song' : 'karaoke', item[listField] || []);
        const data: any = { name: item.name, [listField]: JSON.stringify(refs), isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
        const saved = old ? await tx[kind].update({ where: { id: item.id }, data }) : await tx[kind].create({ data: { ...data, id: item.id, userId, createdAt: BigInt(item.createdAt || now) } });
        await recordChange(tx, userId, entityType, item.id, saved.version, 'upsert', now);
      }
    });
    res.json({ success: true });
  } catch (error: any) {
    const status = ['validation_error', 'invalid_references', 'deleted_conflict'].includes(error.message) ? 400 : 500;
    res.status(status).json({ error: error.message === 'deleted_conflict' ? 'Deleted entities cannot be restored' : `Failed to save ${kind}s` });
  }
}

export const getCustomChords = async (req: Request, res: Response) => {
  try {
    const chords = await prisma.customChord.findMany({ where: { userId: req.userId, deletedAt: null } });
    res.json(serialize(chords));
  } catch (_) { res.status(500).json({ error: 'Failed to fetch chords' }); }
};

export const saveCustomChords = async (req: Request, res: Response) => {
  const userId = req.userId!;
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array of chords' });
  try {
    await prisma.$transaction(async (tx: any) => {
      const now = Date.now();
      const ids = req.body.map((item: any) => item.id);
      const existing = await tx.customChord.findMany({ where: { userId } });
      for (const old of existing) {
        if (!ids.includes(old.id) && old.deletedAt === null) {
          const deleted = await tx.customChord.update({ where: { id: old.id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: old.version + 1, isPublic: false } });
          await recordChange(tx, userId, 'custom_chord', old.id, deleted.version, 'delete', now);
        }
      }
      for (const item of req.body) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.root !== 'string' || !Number.isInteger(Number(item.baseFret))) throw new Error('validation_error');
        const old = existing.find((entry: any) => entry.id === item.id);
        if (old && old.deletedAt !== null) throw new Error('deleted_conflict');
        const data = { name: item.name, root: item.root, frets: asJson(item.frets), fingers: asJson(item.fingers), baseFret: Number(item.baseFret), barres: asJson(item.barres), isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
        const saved = old ? await tx.customChord.update({ where: { id: item.id }, data }) : await tx.customChord.create({ data: { ...data, id: item.id, userId, createdAt: BigInt(now) } });
        await recordChange(tx, userId, 'custom_chord', item.id, saved.version, 'upsert', now);
      }
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(['validation_error', 'deleted_conflict'].includes(error.message) ? 400 : 500).json({ error: 'Failed to save custom chords' });
  }
};
