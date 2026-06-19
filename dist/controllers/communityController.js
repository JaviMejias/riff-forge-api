"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPublicCustomChords = exports.getPublicKaraokes = exports.getPublicSongs = void 0;
const prisma_1 = require("../utils/prisma");
// Helper to serialize BigInts
const serializeBigInts = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value));
const getPublicSongs = async (req, res) => {
    try {
        const songs = await prisma_1.prisma.song.findMany({
            where: { isPublic: true },
            orderBy: { dateAdded: 'desc' },
            take: 50,
            include: {
                user: { select: { id: true, name: true } }
            }
        });
        res.json(serializeBigInts(songs));
    }
    catch (error) {
        console.error('Error fetching public songs:', error);
        res.status(500).json({ error: 'Failed to fetch public songs' });
    }
};
exports.getPublicSongs = getPublicSongs;
const getPublicKaraokes = async (req, res) => {
    try {
        const karaokes = await prisma_1.prisma.karaoke.findMany({
            where: { isPublic: true },
            orderBy: { dateAdded: 'desc' },
            take: 50,
            include: {
                user: { select: { id: true, name: true } }
            }
        });
        res.json(serializeBigInts(karaokes));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch public karaokes' });
    }
};
exports.getPublicKaraokes = getPublicKaraokes;
const getPublicCustomChords = async (req, res) => {
    try {
        const chords = await prisma_1.prisma.customChord.findMany({
            where: { isPublic: true },
            include: {
                user: { select: { id: true, name: true } }
            },
            orderBy: { updatedAt: 'desc' },
            take: 50
        });
        res.json(serializeBigInts(chords));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch public chords' });
    }
};
exports.getPublicCustomChords = getPublicCustomChords;
