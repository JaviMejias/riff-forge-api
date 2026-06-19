import { Request, Response } from 'express';
import youtubedl from 'youtube-dl-exec';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

const uploadDir = path.join(__dirname, '../../uploads');

export const extractAudio = async (req: Request, res: Response) => {
  const { url } = req.body;
  // BE-7 fix: strict regex to prevent "http://evil.com/?r=youtube.com" bypass
  const isYouTube = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
  if (!url || !isYouTube) {
    return res.status(400).json({ error: 'Valid YouTube URL is required' });
  }

  const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const tempFile = path.join(uploadDir, `temp-${uniqueId}.webm`); // yt-dlp usually downloads webm/m4a
  const finalFile = path.join(uploadDir, `yt-${uniqueId}.mp3`);
  const relativeUrl = `/uploads/yt-${uniqueId}.mp3`;

  try {
    // 1. Download best audio
    console.log(`Downloading audio from ${url}...`);
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'best',
      output: tempFile,
      noWarnings: true,
      preferFreeFormats: true,
    });

    // 2. Convert to standard MP3 with ffmpeg
    console.log(`Converting to MP3...`);
    await new Promise((resolve, reject) => {
      ffmpeg(tempFile)
        .toFormat('mp3')
        .audioBitrate(192)
        .on('end', () => resolve(true))
        .on('error', (err) => reject(err))
        .save(finalFile);
    });

    // 3. Cleanup temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    console.log(`Conversion successful: ${relativeUrl}`);
    res.json({ success: true, url: relativeUrl });
  } catch (error) {
    console.error('YouTube extraction error:', error);
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    res.status(500).json({ error: 'Failed to extract audio from YouTube' });
  }
};
