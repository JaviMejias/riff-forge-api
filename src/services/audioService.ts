import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, ExecFileOptions } from 'child_process';
import youtubedl from 'youtube-dl-exec';
import { prisma } from '../utils/prisma';
import { uploadDir } from '../utils/storage';
import { registerFile, requireOwnedFile } from './fileOwnership';
import { safeUploadPath } from './fileMetadata';
import { HttpError } from './httpError';
import { runAudioJob } from './audioJobs';

function runFile(binary: string, args: string[], options: ExecFileOptions) {
  return new Promise<void>((resolve, reject) => {
    execFile(binary, args, options, error => error ? reject(error) : resolve());
  });
}
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const activePitchJobs = new Map<string, Promise<string>>();

async function audioStat(filename: string) {
  return fs.promises.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function assertAudioSize(size: number) {
  if (size > MAX_AUDIO_BYTES) throw new HttpError(413, 'El audio supera el límite de 50 MB');
}

export function normalizeYouTubeUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048) throw new HttpError(400, 'URL de YouTube inválida');
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, 'URL de YouTube inválida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new HttpError(400, 'URL de YouTube inválida');
  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 1) videoId = parts[0];
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else {
      const match = /^\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
      if (match) videoId = match[1];
    }
  }
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new HttpError(400, 'URL de YouTube inválida');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function parsePitchShift(input: unknown) {
  if (typeof input !== 'number' && (typeof input !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(input))) {
    throw new HttpError(400, 'El pitch debe ser un número entre -24 y 24');
  }
  const pitch = Number(input);
  if (!Number.isFinite(pitch) || Math.abs(pitch) > 24) throw new HttpError(400, 'El pitch debe ser un número entre -24 y 24');
  return pitch;
}

export async function downloadYouTubeAudio(userId: string, input: unknown) {
  const url = normalizeYouTubeUrl(input);
  return runAudioJob(userId, async () => {
    const filename = `${crypto.randomUUID()}.mp3`;
    const outputPath = path.join(uploadDir, filename);
    const cloudUrl = `/uploads/${filename}`;
    try {
      await youtubedl(url, {
        extractAudio: true, audioFormat: 'mp3', output: outputPath,
        noWarnings: true, noPlaylist: true, ignoreConfig: true, noCacheDir: true,
        noPart: true, maxFilesize: '50M', socketTimeout: 15, retries: 2,
        matchFilter: 'duration <= 1800 & !is_live'
      }, { timeout: 180000, killSignal: 'SIGKILL' });
      const stat = await audioStat(outputPath);
      if (!stat?.isFile() || stat.size === 0) throw new HttpError(502, 'La descarga no produjo un archivo de audio');
      assertAudioSize(stat.size);
      await registerFile(prisma, userId, cloudUrl);
      return cloudUrl;
    } catch (error) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw error;
    }
  });
}

export async function youtubeMetadata(userId: string, input: unknown) {
  const url = normalizeYouTubeUrl(input);
  return runAudioJob(userId, async () => {
    const data = await youtubedl(url, {
      dumpSingleJson: true, skipDownload: true, noPlaylist: true,
      ignoreConfig: true, noCacheDir: true, noWarnings: true, socketTimeout: 15, retries: 2
    }, { timeout: 30000, killSignal: 'SIGKILL' });
    if (data === null || typeof data !== 'object' || typeof data.title !== 'string') throw new HttpError(502, 'No se pudieron obtener los datos del video');
    return { title: data.title };
  });
}

function tempoFilters(ratio: number) {
  const filters: string[] = [];
  let tempo = 1 / ratio;
  while (tempo < 0.5) { filters.push('atempo=0.5'); tempo /= 0.5; }
  while (tempo > 2) { filters.push('atempo=2'); tempo /= 2; }
  filters.push(`atempo=${tempo}`);
  return filters.join(',');
}

async function renderPitch(userId: string, cloudUrl: string, originalPath: string, pitch: number) {
  const key = crypto.createHash('sha256').update(cloudUrl).update(':').update(String(pitch)).digest('hex');
  const resultUrl = `/uploads/pitch-${key}.mp3`;
  const resultPath = safeUploadPath(resultUrl)!;
  const asset = await prisma.fileAsset.findUnique({ where: { cloudUrl: resultUrl } });
  if (asset?.userId === userId) {
    const stat = await audioStat(resultPath);
    if (stat) {
      if (!stat.isFile()) throw new HttpError(404, 'Archivo no encontrado');
      assertAudioSize(stat.size);
      if (stat.size >= 1000) return resultUrl;
    }
  } else if (asset) {
    throw new HttpError(404, 'Archivo no encontrado');
  }
  return runAudioJob(userId, async () => {
    const temporaryPath = path.join(uploadDir, `processing-${crypto.randomUUID()}.mp3`);
    const ratio = Math.pow(2, pitch / 12);
    const options = { timeout: 120000, killSignal: 'SIGKILL' as const, maxBuffer: 1024 * 1024 };
    try {
      try {
        await runFile('ffmpeg', ['-nostdin', '-i', originalPath, '-af', `rubberband=pitch=${ratio}:formant=preserved`, '-y', temporaryPath], options);
      } catch (error: any) {
        if (error.killed || error.code === 'ENOENT') throw error;
        await runFile('ffmpeg', ['-nostdin', '-i', originalPath, '-af', `aresample=44100,asetrate=44100*${ratio},aresample=44100,${tempoFilters(ratio)}`, '-y', temporaryPath], options);
      }
      const stat = await audioStat(temporaryPath);
      if (!stat?.isFile() || stat.size < 1000) throw new HttpError(502, 'No se pudo generar un archivo de audio válido');
      assertAudioSize(stat.size);
      await prisma.$transaction(async tx => {
        // Reject ownership failures before publishing; rollback registration if rename fails.
        if (!asset) await registerFile(tx, userId, resultUrl);
        await fs.promises.rename(temporaryPath, resultPath);
      });
      return resultUrl;
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  });
}

export async function processAudioPitch(userId: string, inputUrl: unknown, inputPitch: unknown) {
  const pitch = parsePitchShift(inputPitch);
  const originalPath = await requireOwnedFile(prisma, userId, inputUrl);
  const stat = await audioStat(originalPath);
  if (!stat?.isFile()) throw new HttpError(404, 'Archivo no encontrado');
  if (stat.size === 0) throw new HttpError(400, 'El archivo de audio está vacío');
  assertAudioSize(stat.size);
  const cloudUrl = inputUrl as string;
  if (pitch === 0) return cloudUrl;
  const key = `${userId}:${cloudUrl}:${pitch}`;
  const prior = activePitchJobs.get(key);
  if (prior) return prior;
  const job = renderPitch(userId, cloudUrl, originalPath, pitch);
  activePitchJobs.set(key, job);
  try { return await job; } finally { activePitchJobs.delete(key); }
}
