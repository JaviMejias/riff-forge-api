import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import youtubeDl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
// @ts-ignore
import lyricsFinder from 'lyrics-finder';

// Helper to serialize BigInts
const serializeBigInts = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

export const getKaraokes = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const karaokes = await prisma.karaoke.findMany({ where: { userId } });
    res.json(serializeBigInts(karaokes));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch karaokes' });
  }
};

export const createKaraoke = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const data = req.body;
    let cloudUrl = data.cloudUrl;
    
    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
    }

    const karaoke = await prisma.karaoke.create({
      data: {
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
        dateAdded: BigInt(data.dateAdded || Date.now()),
        updatedAt: BigInt(data.updatedAt || Date.now())
      }
    });
    
    res.json(serializeBigInts(karaoke));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create karaoke' });
  }
};

export const updateKaraoke = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const data = req.body;
    let cloudUrl = data.cloudUrl;
    let hasLocalAudio = data.hasLocalAudio;

    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
      hasLocalAudio = true;
    } else {
      hasLocalAudio = hasLocalAudio === 'true' || hasLocalAudio === true;
    }

    const existing = await prisma.karaoke.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Karaoke not found' });
    }

    const updateData: any = {
      name: data.name,
      artist: data.artist,
      youtubeUrl: data.youtubeUrl,
      cloudUrl: cloudUrl,
      hasLocalAudio: hasLocalAudio,
      pitchShift: data.pitchShift ? parseFloat(data.pitchShift) : null,
      textContent: data.textContent,
      updatedAt: BigInt(Date.now())
    };

    if (data.isPublic !== undefined) {
      updateData.isPublic = data.isPublic === 'true' || data.isPublic === true;
    }

    if (data.dateAdded) updateData.dateAdded = BigInt(data.dateAdded);

    const karaoke = await prisma.karaoke.update({
      where: { id },
      data: updateData
    });
    
    res.json(serializeBigInts(karaoke));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update karaoke' });
  }
};

export const deleteKaraoke = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const existing = await prisma.karaoke.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Karaoke not found' });
    }

    if (existing.cloudUrl) {
      const filePath = path.join(__dirname, '../../', existing.cloudUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await prisma.karaoke.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete karaoke' });
  }
};

export const downloadAudio = async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const filename = `${crypto.randomUUID()}.mp3`;
    const outputPath = path.join(__dirname, '../../uploads', filename);

    await youtubeDl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputPath,
      noWarnings: true,
      noCheckCertificates: true,
      extractorArgs: 'youtube:player_client=android,web',
    } as any);

    res.json({ cloudUrl: `/uploads/${filename}` });
  } catch (error) {
    console.error('Error downloading audio:', error);
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

    // If it already exists, return it (caching)
    if (fs.existsSync(processedPath)) {
      return res.json({ cloudUrl: processedCloudUrl });
    }

    // Run FFMPEG with rubberband filter
    // pitchShift is in semitones. Rubberband 'pitch' parameter is a scale factor.
    // Scale factor = 2 ^ (semitones / 12)
    const pitchRatio = Math.pow(2, pitchShift / 12);
    
    // We also use formant=preserved for more professional vocal shifting
    const ffmpegCmd = `ffmpeg -i "${originalPath}" -af "rubberband=pitch=${pitchRatio}:formant=preserved" -y "${processedPath}"`;
    await execPromise(ffmpegCmd);

    res.json({ cloudUrl: processedCloudUrl });
  } catch (error) {
    console.error('Error processing pitch:', error);
    res.status(500).json({ error: 'Failed to process pitch' });
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
