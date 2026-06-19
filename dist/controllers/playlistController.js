"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCustomChords = exports.getCustomChords = exports.saveKaraokePlaylists = exports.getKaraokePlaylists = exports.savePlaylists = exports.getPlaylists = void 0;
const prisma_1 = require("../utils/prisma");
const serializeBigInts = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value));
// ---- Playlists ----
const getPlaylists = async (req, res) => {
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
    const userId = req.userId;
    try {
        const data = req.body;
        // BE-5 fix: validate input is array before deleting anything
        if (!Array.isArray(data)) {
            return res.status(400).json({ error: 'Expected an array of playlists' });
        }
        // BE-5 fix: wrap in transaction so a mid-loop failure doesn't leave user with no data
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.playlist.deleteMany({ where: { userId } });
            for (const pl of data) {
                await tx.playlist.create({
                    data: {
                        id: pl.id,
                        userId,
                        name: pl.name,
                        createdAt: BigInt(pl.createdAt || Date.now()),
                        updatedAt: BigInt(pl.updatedAt || Date.now()),
                        isPublic: pl.isPublic === 'true' || pl.isPublic === true,
                        songs: {
                            connect: (pl.songCloudIds || []).map((id) => ({ id }))
                        }
                    }
                });
            }
        });
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
    const userId = req.userId;
    try {
        const data = req.body;
        // BE-5 fix: validate input is array before deleting anything
        if (!Array.isArray(data)) {
            return res.status(400).json({ error: 'Expected an array of karaoke playlists' });
        }
        // BE-5 fix: wrap in transaction so a mid-loop failure doesn't leave user with no data
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.karaokePlaylist.deleteMany({ where: { userId } });
            for (const pl of data) {
                await tx.karaokePlaylist.create({
                    data: {
                        id: pl.id,
                        userId,
                        name: pl.name,
                        createdAt: BigInt(pl.createdAt || Date.now()),
                        updatedAt: BigInt(pl.updatedAt || Date.now()),
                        isPublic: pl.isPublic === 'true' || pl.isPublic === true,
                        karaokes: {
                            connect: (pl.karaokeCloudIds || []).map((id) => ({ id }))
                        }
                    }
                });
            }
        });
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
    const userId = req.userId;
    try {
        const data = req.body;
        // BE-5 fix: validate input is array before deleting anything
        if (!Array.isArray(data)) {
            return res.status(400).json({ error: 'Expected an array of chords' });
        }
        // BE-5 fix: wrap in transaction so a mid-loop failure doesn't leave user with no data
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.customChord.deleteMany({ where: { userId } });
            for (const c of data) {
                await tx.customChord.create({
                    data: {
                        id: c.id,
                        userId,
                        name: c.name,
                        root: c.root,
                        frets: typeof c.frets === 'string' ? c.frets : JSON.stringify(c.frets),
                        fingers: typeof c.fingers === 'string' ? c.fingers : JSON.stringify(c.fingers),
                        baseFret: parseInt(c.baseFret),
                        barres: typeof c.barres === 'string' ? c.barres : JSON.stringify(c.barres || []),
                        updatedAt: BigInt(c.updatedAt || Date.now()),
                        isPublic: c.isPublic === 'true' || c.isPublic === true
                    }
                });
            }
        });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to save custom chords' });
    }
};
exports.saveCustomChords = saveCustomChords;
