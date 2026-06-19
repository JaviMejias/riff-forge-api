import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';

// Helper to serialize BigInts
const serializeBigInts = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

export const getSongs = async (req: Request, res: Response) => {
  const userId = req.userId;
  try {
    const songs = await prisma.song.findMany({ where: { userId } });
    res.json(serializeBigInts(songs));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
};

export const createSong = async (req: Request, res: Response) => {
  const userId = req.userId;
  try {
    const data = req.body;
    
    // Handle file upload
    let cloudUrl = data.cloudUrl;
    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
    }

    const song = await prisma.song.create({
      data: {
        id: data.id,
        userId,
        name: data.name,
        artist: data.artist,
        album: data.album,
        type: data.type,
        cloudUrl: cloudUrl,
        textContent: data.textContent,
        originalKey: data.originalKey,
        tuning: data.tuning,
        strummingPattern: data.strummingPattern,
        capo: data.capo,
        isPublic: data.isPublic === 'true' || data.isPublic === true,
        dateAdded: BigInt(data.dateAdded || Date.now()),
        updatedAt: BigInt(data.updatedAt || Date.now())
      }
    });
    
    // Convert BigInt to string for JSON serialization
    res.json(JSON.parse(JSON.stringify(song, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    )));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create song' });
  }
};

export const updateSong = async (req: Request, res: Response) => {
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const data = req.body;
    let cloudUrl = data.cloudUrl;
    if (req.file) {
      cloudUrl = `/uploads/${req.file.filename}`;
    }

    // Verify ownership
    const existing = await prisma.song.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Song not found' });
    }

    const updateData: any = {
      name: data.name,
      artist: data.artist,
      album: data.album,
      type: data.type,
      textContent: data.textContent,
      originalKey: data.originalKey,
      tuning: data.tuning,
      strummingPattern: data.strummingPattern,
      capo: data.capo,
      cloudUrl: cloudUrl,
      updatedAt: BigInt(Date.now())
    };
    if (data.isPublic !== undefined) {
      updateData.isPublic = data.isPublic === 'true' || data.isPublic === true;
    }
    if (data.dateAdded) updateData.dateAdded = BigInt(data.dateAdded);

    const song = await prisma.song.update({
      where: { id },
      data: updateData
    });
    
    res.json(JSON.parse(JSON.stringify(song, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    )));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update song' });
  }
};

export const deleteSong = async (req: Request, res: Response) => {
  const userId = req.userId;
  const id = req.params.id as string;
  try {
    const existing = await prisma.song.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Song not found' });
    }

    await prisma.song.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete song' });
  }
};
