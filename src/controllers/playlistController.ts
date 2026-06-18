import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';

const serializeBigInts = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

// ---- Playlists ----
export const getPlaylists = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const playlists = await prisma.playlist.findMany({ where: { userId }, include: { songs: true } });
    
    // Map songs array to songCloudIds array for frontend
    const mapped = playlists.map(p => ({
      ...p,
      songCloudIds: p.songs.map(s => s.id)
    }));

    res.json(serializeBigInts(mapped));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
};

export const savePlaylists = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const data = req.body; // Array of playlists
    await prisma.playlist.deleteMany({ where: { userId } });
    
    for (const pl of data) {
      await prisma.playlist.create({
        data: {
          id: pl.id,
          userId,
          name: pl.name,
          createdAt: BigInt(pl.createdAt || Date.now()),
          updatedAt: BigInt(pl.updatedAt || Date.now()),
          songs: {
            connect: (pl.songCloudIds || []).map((id: string) => ({ id }))
          }
        }
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save playlists' });
  }
};

// ---- Karaoke Playlists ----
export const getKaraokePlaylists = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const playlists = await prisma.karaokePlaylist.findMany({ where: { userId }, include: { karaokes: true } });
    
    const mapped = playlists.map(p => ({
      ...p,
      karaokeCloudIds: p.karaokes.map(k => k.id)
    }));

    res.json(serializeBigInts(mapped));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch karaoke playlists' });
  }
};

export const saveKaraokePlaylists = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const data = req.body; // Array of karaoke playlists
    await prisma.karaokePlaylist.deleteMany({ where: { userId } });
    
    for (const pl of data) {
      await prisma.karaokePlaylist.create({
        data: {
          id: pl.id,
          userId,
          name: pl.name,
          createdAt: BigInt(pl.createdAt || Date.now()),
          updatedAt: BigInt(pl.updatedAt || Date.now()),
          karaokes: {
            connect: (pl.karaokeCloudIds || []).map((id: string) => ({ id }))
          }
        }
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save karaoke playlists' });
  }
};

// ---- Custom Chords ----
export const getCustomChords = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const chords = await prisma.customChord.findMany({ where: { userId } });
    res.json(serializeBigInts(chords));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chords' });
  }
};

export const saveCustomChords = async (req: Request, res: Response) => {
  // @ts-ignore
  const userId = req.userId;
  try {
    const data = req.body; // Array of custom chords
    await prisma.customChord.deleteMany({ where: { userId } });
    
    for (const c of data) {
      await prisma.customChord.create({
        data: {
          id: c.id,
          userId,
          name: c.name,
          root: c.root,
          frets: typeof c.frets === 'string' ? c.frets : JSON.stringify(c.frets),
          fingers: typeof c.fingers === 'string' ? c.fingers : JSON.stringify(c.fingers),
          baseFret: parseInt(c.baseFret),
          barres: typeof c.barres === 'string' ? c.barres : JSON.stringify(c.barres || []),
          updatedAt: BigInt(c.updatedAt || Date.now())
        }
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save custom chords' });
  }
};
