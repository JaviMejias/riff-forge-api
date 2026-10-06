import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { prisma } from '../utils/prisma';
import { fileMetadata } from '../services/fileMetadata';
import { discardPendingCopies, registerFile, resolveFileReference, requireOwnedFile } from '../services/fileOwnership';
import { recordChange } from '../services/syncService';
import { downloadYouTubeAudio, processAudioPitch, youtubeMetadata, parsePitchShift } from '../services/audioService';
import { HttpError } from '../services/httpError';
import { assertEntityVersion, updateVersioned, versionConflict } from '../services/versionedWrites';
import { validateMetadata } from '../services/inputValidation';

const serialize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));

async function discardUpload(req: Request) {
  if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
}

function optionalPitch(value: unknown) {
  return value === null || value === '' || value === undefined ? null : parsePitchShift(value);
}

export const getKaraokes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const karaokes = await prisma.karaoke.findMany({ where: { userId: req.userId, deletedAt: null } });
    res.json(serialize(karaokes));
  } catch (error) { next(error); }
};

export const createKaraoke = async (req: Request, res: Response, next: NextFunction) => {
  const pendingCopies = new Set<string>();
  let committed = false;
  try {
    const data = req.body || {};
    validateMetadata('karaoke', data, true, true);
    if (data.id !== undefined && (typeof data.id !== 'string' || !data.id)) throw new HttpError(400, 'Identificador inválido');
    const now = Date.now();
    const karaoke = await prisma.$transaction(async tx => {
      if (data.id !== undefined) {
        const existing = await tx.karaoke.findUnique({ where: { id: data.id } });
        if (existing?.userId !== undefined && existing.userId !== req.userId) throw new HttpError(404, 'Registro no encontrado');
        if (existing) throw versionConflict('karaoke', existing);
      }
      let cloudUrl: string | null;
      if (req.file) {
        cloudUrl = `/uploads/${req.file.filename}`;
        await registerFile(tx, req.userId, cloudUrl);
      } else {
        cloudUrl = await resolveFileReference(tx, req.userId, data.cloudUrl, pendingCopies);
      }
      const created = await tx.karaoke.create({ data: {
        id: data.id, userId: req.userId, name: data.name, artist: data.artist,
        youtubeUrl: data.youtubeUrl, cloudUrl,
        hasLocalAudio: !!cloudUrl || data.hasLocalAudio === true || data.hasLocalAudio === 'true',
        pitchShift: optionalPitch(data.pitchShift), textContent: data.textContent,
        isPublic: data.isPublic === true || data.isPublic === 'true',
        dateAdded: BigInt(data.dateAdded ?? now), createdAt: BigInt(now), updatedAt: BigInt(now),
        version: 1, fileVersion: cloudUrl ? 1 : 0,
        ...fileMetadata(cloudUrl, req.file?.mimetype)
      } });
      await recordChange(tx, req.userId, 'karaoke', created.id, created.version, 'upsert', now);
      return created;
    });
    committed = true;
    res.json(serialize(karaoke));
  } catch (error) {
    if (!committed) {
      await discardPendingCopies(pendingCopies);
      await discardUpload(req);
    }
    next(error);
  }
};

export const updateKaraoke = async (req: Request, res: Response, next: NextFunction) => {
  let committed = false;
  try {
    const data = req.body || {};
    validateMetadata('karaoke', data, false, true);
    const id = req.params.id as string;
    const karaoke = await prisma.$transaction(async tx => {
      const existing = await tx.karaoke.findFirst({ where: { id, userId: req.userId } });
      if (!existing) throw new HttpError(404, 'Karaoke no encontrado');
      assertEntityVersion(req, 'karaoke', existing);
      const cloudUrl = req.file ? `/uploads/${req.file.filename}` : existing.cloudUrl;
      if (req.file) await registerFile(tx, req.userId, cloudUrl!);
      const updated = await updateVersioned(tx, 'karaoke', existing, {
        name: data.name, artist: data.artist, youtubeUrl: data.youtubeUrl, cloudUrl,
        hasLocalAudio: req.file ? true : data.hasLocalAudio === undefined ? existing.hasLocalAudio : data.hasLocalAudio === true || data.hasLocalAudio === 'true',
        pitchShift: data.pitchShift === undefined ? existing.pitchShift : optionalPitch(data.pitchShift),
        textContent: data.textContent,
        isPublic: data.isPublic === undefined ? existing.isPublic : data.isPublic === true || data.isPublic === 'true',
        dateAdded: data.dateAdded === undefined ? existing.dateAdded : BigInt(data.dateAdded),
        updatedAt: BigInt(Date.now()),
        ...(req.file ? { ...fileMetadata(cloudUrl, req.file.mimetype), fileVersion: existing.fileVersion + 1 } : {})
      });
      await recordChange(tx, req.userId, 'karaoke', id, updated.version, 'upsert');
      return updated;
    });
    committed = true;
    res.json(serialize(karaoke));
  } catch (error) {
    if (!committed) await discardUpload(req);
    next(error);
  }
};

export const deleteKaraoke = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.$transaction(async tx => {
      const existing = await tx.karaoke.findFirst({ where: { id, userId: req.userId } });
      if (!existing) throw new HttpError(404, 'Karaoke no encontrado');
      assertEntityVersion(req, 'karaoke', existing);
      const now = Date.now();
      const updated = await updateVersioned(tx, 'karaoke', existing, {
        deletedAt: BigInt(now), updatedAt: BigInt(now), isPublic: false
      });
      await recordChange(tx, req.userId, 'karaoke', id, updated.version, 'delete', now);
    });
    res.json({ success: true });
  } catch (error) { next(error); }
};

export const downloadAudio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cloudUrl = await downloadYouTubeAudio(req.userId, req.body?.url);
    res.json({ cloudUrl });
  } catch (error) { next(error); }
};

export const processPitch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cloudUrl = await processAudioPitch(req.userId, req.body?.cloudUrl, req.body?.pitchShift);
    res.json({ cloudUrl });
  } catch (error) { next(error); }
};

export const fetchLyrics = async (req: Request, res: Response, next: NextFunction) => {
  const { title, artist } = req.query;
  if (typeof title !== 'string' || !title) return res.status(400).json({ error: 'Title is required' });
  try {
    const params = new URLSearchParams({ track_name: title, artist_name: typeof artist === 'string' ? artist : '' });
    const response = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { 'User-Agent': 'RiffForge/1.0.0 (https://github.com/javier/riff-forge)' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new HttpError(502, 'No se pudieron obtener las letras');
    const data = await response.json();
    const lyrics = Array.isArray(data) ? data[0]?.syncedLyrics || data[0]?.plainLyrics : null;
    if (!lyrics) return res.status(404).json({ error: 'No se encontró letra para esta canción.' });
    res.json({ lyrics });
  } catch (error) { next(error); }
};

export const getYouTubeMetadata = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await youtubeMetadata(req.userId, req.query.url));
  } catch (error) { next(error); }
};

export const deleteAudio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cloudUrl = req.body?.cloudUrl;
    await prisma.$transaction(async tx => {
      await requireOwnedFile(tx, req.userId, cloudUrl);
      const id = req.body?.id;
      if (id !== undefined && (typeof id !== 'string' || !id)) throw new HttpError(400, 'Identificador de karaoke inválido');
      const matches = await tx.karaoke.findMany({ where: { userId: req.userId, cloudUrl, deletedAt: null, ...(id ? { id } : {}) }, take: 2 });
      if (matches.length > 1) throw new HttpError(409, 'Indica el karaoke del que quieres quitar el audio', { code: 'ambiguous_audio_reference' });
      const owned = matches[0];
      if (!owned) throw new HttpError(404, 'Audio no encontrado');
      assertEntityVersion(req, 'karaoke', owned);
      const now = Date.now();
      const updated = await updateVersioned(tx, 'karaoke', owned, {
        cloudUrl: null, hasLocalAudio: false, fileHash: null, fileSize: null, fileMimeType: null,
        fileVersion: owned.fileVersion + 1, updatedAt: BigInt(now)
      });
      await recordChange(tx, req.userId, 'karaoke', owned.id, updated.version, 'upsert', now);
    });
    // Retention-based cleanup preserves shared references and older sync snapshots.
    res.json({ success: true, message: 'Audio eliminado de la biblioteca' });
  } catch (error) { next(error); }
};
