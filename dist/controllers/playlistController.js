"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCustomChords = exports.getCustomChords = exports.saveKaraokePlaylists = exports.getKaraokePlaylists = exports.savePlaylists = exports.getPlaylists = void 0;
const prisma_1 = require("../utils/prisma");
const serializeBigInts = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value));
// ---- Playlists ----
const getPlaylists = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const playlists = await prisma_1.prisma.playlist.findMany({ where: { userId }, include: { songs: true } });
        // Map songs array to songCloudIds array for frontend
        const mapped = playlists.map(p => ({
            ...p,
            songCloudIds: p.songs.map(s => s.id)
        }));
        res.json(serializeBigInts(mapped));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
};
exports.getPlaylists = getPlaylists;
const savePlaylists = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const data = req.body; // Array of playlists
        await prisma_1.prisma.playlist.deleteMany({ where: { userId } });
        for (const pl of data) {
            await prisma_1.prisma.playlist.create({
                data: {
                    id: pl.id,
                    userId,
                    name: pl.name,
                    createdAt: BigInt(pl.createdAt || Date.now()),
                    updatedAt: BigInt(pl.updatedAt || Date.now()),
                    songs: {
                        connect: (pl.songCloudIds || []).map((id) => ({ id }))
                    }
                }
            });
        }
        res.json({ success: true });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to save playlists' });
    }
};
exports.savePlaylists = savePlaylists;
// ---- Karaoke Playlists ----
const getKaraokePlaylists = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const playlists = await prisma_1.prisma.karaokePlaylist.findMany({ where: { userId }, include: { karaokes: true } });
        const mapped = playlists.map(p => ({
            ...p,
            karaokeCloudIds: p.karaokes.map(k => k.id)
        }));
        res.json(serializeBigInts(mapped));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch karaoke playlists' });
    }
};
exports.getKaraokePlaylists = getKaraokePlaylists;
const saveKaraokePlaylists = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const data = req.body; // Array of karaoke playlists
        await prisma_1.prisma.karaokePlaylist.deleteMany({ where: { userId } });
        for (const pl of data) {
            await prisma_1.prisma.karaokePlaylist.create({
                data: {
                    id: pl.id,
                    userId,
                    name: pl.name,
                    createdAt: BigInt(pl.createdAt || Date.now()),
                    updatedAt: BigInt(pl.updatedAt || Date.now()),
                    karaokes: {
                        connect: (pl.karaokeCloudIds || []).map((id) => ({ id }))
                    }
                }
            });
        }
        res.json({ success: true });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to save karaoke playlists' });
    }
};
exports.saveKaraokePlaylists = saveKaraokePlaylists;
// ---- Custom Chords ----
const getCustomChords = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const chords = await prisma_1.prisma.customChord.findMany({ where: { userId } });
        res.json(serializeBigInts(chords));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch chords' });
    }
};
exports.getCustomChords = getCustomChords;
const saveCustomChords = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const data = req.body; // Array of custom chords
        await prisma_1.prisma.customChord.deleteMany({ where: { userId } });
        for (const c of data) {
            await prisma_1.prisma.customChord.create({
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
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to save custom chords' });
    }
};
exports.saveCustomChords = saveCustomChords;
