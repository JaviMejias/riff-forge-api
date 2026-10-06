import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { prisma } from '../utils/prisma';
import { fileMetadata } from '../services/fileMetadata';
import { discardPendingCopies, registerFile, resolveFileReference } from '../services/fileOwnership';
import { recordChange } from '../services/syncService';
import { HttpError } from '../services/httpError';
import { assertEntityVersion, updateVersioned, versionConflict } from '../services/versionedWrites';
import { validateMetadata } from '../services/inputValidation';

const serialize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));

async function discardUpload(req: Request) {
  if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
}

export const getSongs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const songs = await prisma.song.findMany({ where: { userId: req.userId, deletedAt: null } });
    res.json(serialize(songs));
  } catch (error) { next(error); }
};

export const createSong = async (req: Request, res: Response, next: NextFunction) => {
  const pendingCopies = new Set<string>();
  let committed = false;
  try {
    const data = req.body || {};
    validateMetadata('song', data, true, true);
    if (data.id !== undefined && (typeof data.id !== 'string' || !data.id)) throw new HttpError(400, 'Identificador inválido');
    const now = Date.now();
    const song = await prisma.$transaction(async tx => {
      if (data.id !== undefined) {
        const existing = await tx.song.findUnique({ where: { id: data.id } });
        if (existing?.userId !== undefined && existing.userId !== req.userId) throw new HttpError(404, 'Registro no encontrado');
        if (existing) throw versionConflict('song', existing);
      }
      let cloudUrl: string | null;
      if (req.file) {
        cloudUrl = `/uploads/${req.file.filename}`;
        await registerFile(tx, req.userId, cloudUrl);
      } else {
        cloudUrl = await resolveFileReference(tx, req.userId, data.cloudUrl, pendingCopies);
      }
      const created = await tx.song.create({ data: {
        id: data.id, userId: req.userId, name: data.name, artist: data.artist, album: data.album,
        type: data.type, cloudUrl, textContent: data.textContent, originalKey: data.originalKey,
        tuning: data.tuning, strummingPattern: data.strummingPattern, capo: data.capo,
        isPublic: data.isPublic === 'true' || data.isPublic === true,
        dateAdded: BigInt(data.dateAdded ?? now), createdAt: BigInt(now), updatedAt: BigInt(now),
        version: 1, fileVersion: cloudUrl ? 1 : 0, ...fileMetadata(cloudUrl, req.file?.mimetype)
      } });
      await recordChange(tx, req.userId, 'song', created.id, created.version, 'upsert', now);
      return created;
    });
    committed = true;
    res.json(serialize(song));
  } catch (error) {
    if (!committed) {
      await discardPendingCopies(pendingCopies);
      await discardUpload(req);
    }
    next(error);
  }
};

export const updateSong = async (req: Request, res: Response, next: NextFunction) => {
  let committed = false;
  try {
    const data = req.body || {};
    validateMetadata('song', data, false, true);
    const id = req.params.id as string;
    const song = await prisma.$transaction(async tx => {
      const existing = await tx.song.findFirst({ where: { id, userId: req.userId } });
      if (!existing) throw new HttpError(404, 'Canción no encontrada');
      assertEntityVersion(req, 'song', existing);
      const cloudUrl = req.file ? `/uploads/${req.file.filename}` : existing.cloudUrl;
      if (req.file) await registerFile(tx, req.userId, cloudUrl!);
      const updated = await updateVersioned(tx, 'song', existing, {
        name: data.name, artist: data.artist, album: data.album, type: data.type,
        textContent: data.textContent, originalKey: data.originalKey, tuning: data.tuning,
        strummingPattern: data.strummingPattern, capo: data.capo, cloudUrl,
        isPublic: data.isPublic === undefined ? existing.isPublic : data.isPublic === 'true' || data.isPublic === true,
        dateAdded: data.dateAdded === undefined ? existing.dateAdded : BigInt(data.dateAdded),
        updatedAt: BigInt(Date.now()),
        ...(req.file ? { ...fileMetadata(cloudUrl, req.file.mimetype), fileVersion: existing.fileVersion + 1 } : {})
      });
      await recordChange(tx, req.userId, 'song', id, updated.version, 'upsert');
      return updated;
    });
    committed = true;
    res.json(serialize(song));
  } catch (error) {
    if (!committed) await discardUpload(req);
    next(error);
  }
};

export const deleteSong = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.$transaction(async tx => {
      const existing = await tx.song.findFirst({ where: { id, userId: req.userId } });
      if (!existing) throw new HttpError(404, 'Canción no encontrada');
      assertEntityVersion(req, 'song', existing);
      const now = Date.now();
      const updated = await updateVersioned(tx, 'song', existing, {
        deletedAt: BigInt(now), updatedAt: BigInt(now), isPublic: false
      });
      await recordChange(tx, req.userId, 'song', id, updated.version, 'delete', now);
    });
    res.json({ success: true });
  } catch (error) { next(error); }
};
