import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';

// Helper to serialize BigInts
const serializeBigInts = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

export const getPublicSongs = async (req: Request, res: Response) => {
  try {
    const songs = await prisma.song.findMany({ 
      where: { isPublic: true },
      include: {
        user: { select: { id: true, name: true } }
      },
      orderBy: { dateAdded: 'desc' },
      take: 50
    });
    res.json(serializeBigInts(songs));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch public songs' });
  }
};

export const getPublicKaraokes = async (req: Request, res: Response) => {
  try {
    const karaokes = await prisma.karaoke.findMany({ 
      where: { isPublic: true },
      include: {
        user: { select: { id: true, name: true } }
      },
      orderBy: { dateAdded: 'desc' },
      take: 50
    });
    res.json(serializeBigInts(karaokes));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch public karaokes' });
  }
};

export const getPublicCustomChords = async (req: Request, res: Response) => {
  try {
    const chords = await prisma.customChord.findMany({ 
      where: { isPublic: true },
      include: {
        user: { select: { id: true, name: true } }
      },
      orderBy: { updatedAt: 'desc' },
      take: 50
    });
    res.json(serializeBigInts(chords));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch public chords' });
  }
};
