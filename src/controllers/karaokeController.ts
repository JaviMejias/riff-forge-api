import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
import youtubedl from 'youtube-dl-exec';
import { fileMetadata, safeUploadPath } from '../services/fileMetadata';
import { recordChange } from '../services/syncService';
const execPromise = util.promisify(exec);
// Helper to serialize BigInts
const serializeBigInts = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

export const getKaraokes = async (req: Request, res: Response) => {
  const userId = req.userId;
  try {
    const karaokes = await prisma.karaoke.findMany({ where: { userId, deletedAt: null } });
    res.json(serializeBigInts(karaokes));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch karaokes' });
  }
};

export const createKaraoke = async (req: Request, res: Response) => {
  const userId = req.userId;
  try {
    const data = req.body;
    let cloudUrl = data.cloudUrl;
    
    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
    }

    const now = Date.now();
    const metadata = fileMetadata(cloudUrl, req.file && req.file.mimetype);
    const karaoke = await prisma.$transaction(async (tx: any) => {
      const created = await tx.karaoke.create({ data: {
        id: data.id,
        userId,
        name: data.name,
        artist: data.artist,
        youtubeUrl: data.youtubeUrl,
        cloudUrl: cloudUrl,
        hasLocalAudio: req.file ? true : (data.hasLocalAudio === 'true' || data.hasLocalAudio === true),
        pitchShift: data.pitchShift ? parseFloat(data.pitchShift) : null,
        textContent: data.textContent,
        isPublic: data.isPublic === 'true' || data.isPublic === true,
        dateAdded: BigInt(data.dateAdded || now),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        version: 1,
        fileVersion: cloudUrl ? 1 : 0,
        ...metadata
      } });
      await recordChange(tx, userId!, 'karaoke', created.id, created.version, 'upsert', now);
      return created;
    });
    
    res.json(serializeBigInts(karaoke));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create karaoke' });
  }
};

export const updateKaraoke = async (req: Request, res: Response) => {
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const data = req.body;
    let cloudUrl: string | undefined;
    let hasLocalAudio = data.hasLocalAudio;

    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
      hasLocalAudio = true;
    } else {
      hasLocalAudio = hasLocalAudio === 'true' || hasLocalAudio === true;
    }

    const existing: any = await prisma.karaoke.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      return res.status(404).json({ error: 'Karaoke not found' });
    }

    const updateData: any = {
      name: data.name,
      artist: data.artist,
      youtubeUrl: data.youtubeUrl,
      cloudUrl: req.file ? cloudUrl : existing.cloudUrl,
      hasLocalAudio: hasLocalAudio,
      pitchShift: data.pitchShift ? parseFloat(data.pitchShift) : null,
      textContent: data.textContent,
      updatedAt: BigInt(Date.now()),
      version: existing.version + 1
    };
    if (req.file) Object.assign(updateData, fileMetadata(cloudUrl, req.file.mimetype), { fileVersion: existing.fileVersion + 1 });

    if (data.isPublic !== undefined) {
      updateData.isPublic = data.isPublic === 'true' || data.isPublic === true;
    }

    if (data.dateAdded) updateData.dateAdded = BigInt(data.dateAdded);

    const karaoke = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.karaoke.update({ where: { id }, data: updateData });
      await recordChange(tx, userId!, 'karaoke', id, updated.version, 'upsert');
      return updated;
    });
    
    res.json(serializeBigInts(karaoke));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update karaoke' });
  }
};

export const deleteKaraoke = async (req: Request, res: Response) => {
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const existing: any = await prisma.karaoke.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      return res.status(404).json({ error: 'Karaoke not found' });
    }

    const now = Date.now();
    await prisma.$transaction(async (tx: any) => {
      const updated = await tx.karaoke.update({ where: { id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: existing.version + 1, isPublic: false } });
      await recordChange(tx, userId!, 'karaoke', id, updated.version, 'delete', now);
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete karaoke' });
  }
};

import { Readable } from 'stream';

export const downloadAudio = async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let outputPath = '';
  try {
    const filename = `${crypto.randomUUID()}.mp3`;
    outputPath = path.join(__dirname, '../../uploads', filename);

    // 1. Extraer ID del video de YouTube (opcional, youtube-dl acepta URL completa, pero validamos que sea YT)
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
    const videoId = match ? match[1] : null;

    if (!videoId) {
      return res.status(400).json({ error: 'URL de YouTube inválida' });
    }

    // 2. Descargar y convertir a MP3 usando youtube-dl-exec (yt-dlp)
    console.log(`Downloading audio for ${videoId}...`);
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputPath,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    console.log(`Audio downloaded successfully to ${outputPath}`);

    // 3. Devolver el enlace local
    res.json({ cloudUrl: `/uploads/${filename}` });
  } catch (error) {
    console.error('Error downloading audio via youtube-dl:', error);
    // M-11 fix: remove partial file if it failed
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {
        console.error('Failed to clean up partial file:', e);
      }
    }
    res.status(500).json({ error: 'Failed to download audio' });
  }
};

export const processPitch = async (req: Request, res: Response) => {
  const { cloudUrl, pitchShift } = req.body;

  if (pitchShift === undefined) {
    return res.status(400).json({ error: 'pitchShift is required' });
  }
  if (!cloudUrl || typeof cloudUrl !== 'string' || !cloudUrl.startsWith('/uploads/')) {
    return res.status(400).json({ error: 'Invalid cloudUrl' });
  }

  try {
    const originalPath = path.join(__dirname, '../../', cloudUrl);
    const uploadsDir = path.join(__dirname, '../../uploads');
    
    // Security check to prevent path traversal
    if (!originalPath.startsWith(uploadsDir)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: 'Original audio file not found on server' });
    }

    if (pitchShift === 0) {
      return res.json({ cloudUrl });
    }

    // Determine processed filename and path
    // We base the new filename on the original file name, without the extension
    const baseName = path.basename(cloudUrl, '.mp3');
    // If baseName already has _pitch_, strip it to get the raw base name
    const rawBaseName = baseName.split('_pitch_')[0];
    const processedFilename = `${rawBaseName}_pitch_${pitchShift}.mp3`;
    const processedPath = path.join(uploadsDir, processedFilename);
    const processedCloudUrl = `/uploads/${processedFilename}`;

    // If it already exists and is valid (not 0 bytes), return it (caching)
    if (fs.existsSync(processedPath)) {
      const stats = fs.statSync(processedPath);
      if (stats.size > 1000) { // If it's larger than 1KB, it's a valid file
        return res.json({ cloudUrl: processedCloudUrl });
      } else {
        // Delete the corrupted/empty file
        fs.unlinkSync(processedPath);
      }
    }

    // Run FFMPEG with rubberband filter
    // pitchShift is in semitones. Rubberband 'pitch' parameter is a scale factor.
    // Scale factor = 2 ^ (semitones / 12)
    const pitchRatio = Math.pow(2, pitchShift / 12);
    
    // We also use formant=preserved for more professional vocal shifting
    const ffmpegCmd = `ffmpeg -i "${originalPath}" -af "rubberband=pitch=${pitchRatio}:formant=preserved" -y "${processedPath}"`;
    
    try {
      await execPromise(ffmpegCmd);
      
      // Verify the output file size
      if (fs.existsSync(processedPath)) {
        const stats = fs.statSync(processedPath);
        if (stats.size < 1000) {
          throw new Error("FFMPEG produced an empty or corrupted file");
        }
      } else {
        throw new Error("FFMPEG did not produce an output file");
      }
    } catch (ffmpegErr) {
      console.warn('Rubberband filter failed, trying lightweight fallback (asetrate/atempo)...', ffmpegErr);
      
      // Clean up the empty file if FFMPEG failed
      if (fs.existsSync(processedPath)) {
        fs.unlinkSync(processedPath);
      }
      
      // Fallback command: very low memory usage, decent quality. Assumes 44100Hz input.
      const fallbackCmd = `ffmpeg -i "${originalPath}" -af "asetrate=44100*${pitchRatio},atempo=1/${pitchRatio}" -y "${processedPath}"`;
      await execPromise(fallbackCmd);
      
      if (fs.existsSync(processedPath)) {
        const stats = fs.statSync(processedPath);
        if (stats.size < 1000) {
          throw new Error("FFMPEG fallback produced an empty or corrupted file");
        }
      } else {
        throw new Error("FFMPEG fallback did not produce an output file");
      }
    }

    res.json({ cloudUrl: processedCloudUrl });
  } catch (error) {
    console.error('Error processing pitch:', error);
    res.status(500).json({ error: 'Failed to process pitch. The server might have run out of memory.' });
  }
};

export const fetchLyrics = async (req: Request, res: Response) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  try {
    const params = new URLSearchParams({
      track_name: title as string,
      artist_name: (artist as string) || ''
    });

    const response = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: {
        'User-Agent': 'RiffForge/1.0.0 (https://github.com/javier/riff-forge)'
      },
      signal: AbortSignal.timeout(20000)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch from lrclib: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No se encontró letra para esta canción.' });
    }

    const firstResult = data[0];
    
    // Si la API provee letra sincronizada (LRC), la preferimos, si no la plana.
    const lyrics = firstResult.syncedLyrics || firstResult.plainLyrics;

    if (!lyrics) {
      return res.status(404).json({ error: 'No se encontró letra para esta canción.' });
    }

    res.json({ lyrics });
  } catch (error) {
    console.error('Error fetching lyrics:', error);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
};

export const getYouTubeMetadata = async (req: Request, res: Response) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const data = await youtubedl(url, {
      dumpJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });
    // @ts-ignore
    res.json({ title: data.title });
  } catch (error) {
    console.error('Error fetching youtube metadata:', error);
    res.status(500).json({ error: 'Failed to fetch youtube metadata' });
  }
};

export const deleteAudio = async (req: Request, res: Response) => {
  const { cloudUrl } = req.body;
  if (!cloudUrl) return res.status(400).json({ error: 'cloudUrl is required' });

  try {
    const owned: any = await prisma.karaoke.findFirst({ where: { userId: req.userId, cloudUrl, deletedAt: null } });
    if (!owned) return res.status(404).json({ error: 'Audio not found' });
    const filePath = safeUploadPath(cloudUrl);
    if (!filePath) return res.status(400).json({ error: 'Invalid cloudUrl' });
    const now = Date.now();
    await prisma.$transaction(async (tx: any) => {
      const updated = await tx.karaoke.update({ where: { id: owned.id }, data: { cloudUrl: null, hasLocalAudio: false, fileHash: null, fileSize: null, fileMimeType: null, fileVersion: owned.fileVersion + 1, version: owned.version + 1, updatedAt: BigInt(now) } });
      await recordChange(tx, req.userId!, 'karaoke', owned.id, updated.version, 'upsert', now);
    });
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    console.error('Error deleting audio:', error);
    res.status(500).json({ error: 'Failed to delete audio file' });
  }
};
