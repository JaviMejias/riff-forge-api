"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSong = exports.updateSong = exports.createSong = exports.getSongs = void 0;
const prisma_1 = require("../utils/prisma");
const fileMetadata_1 = require("../services/fileMetadata");
const syncService_1 = require("../services/syncService");
// Helper to serialize BigInts
const serializeBigInts = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value));
const getSongs = async (req, res) => {
    const userId = req.userId;
    try {
        const songs = await prisma_1.prisma.song.findMany({ where: { userId, deletedAt: null } });
        res.json(serializeBigInts(songs));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch songs' });
    }
};
exports.getSongs = getSongs;
const createSong = async (req, res) => {
    const userId = req.userId;
    try {
        const data = req.body;
        // Handle file upload
        let cloudUrl = data.cloudUrl;
        if (req.file) {
            cloudUrl = `/uploads/${req.file.filename}`;
        }
        const now = Date.now();
        const metadata = (0, fileMetadata_1.fileMetadata)(cloudUrl, req.file && req.file.mimetype);
        const song = await prisma_1.prisma.$transaction(async (tx) => {
            const created = await tx.song.create({ data: {
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
                    dateAdded: BigInt(data.dateAdded || now),
                    createdAt: BigInt(now),
                    updatedAt: BigInt(now),
                    version: 1,
                    fileVersion: cloudUrl ? 1 : 0,
                    ...metadata
                } });
            await (0, syncService_1.recordChange)(tx, userId, 'song', created.id, created.version, 'upsert', now);
            return created;
        });
        // Convert BigInt to string for JSON serialization
        res.json(JSON.parse(JSON.stringify(song, (key, value) => typeof value === 'bigint' ? value.toString() : value)));
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create song' });
    }
};
exports.createSong = createSong;
const updateSong = async (req, res) => {
    const userId = req.userId;
    const id = req.params.id;
    try {
        const data = req.body;
        let cloudUrl;
        if (req.file) {
            cloudUrl = `/uploads/${req.file.filename}`;
        }
        // Verify ownership
        const existing = await prisma_1.prisma.song.findUnique({ where: { id } });
        if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
            return res.status(404).json({ error: 'Song not found' });
        }
        const updateData = {
            name: data.name,
            artist: data.artist,
            album: data.album,
            type: data.type,
            textContent: data.textContent,
            originalKey: data.originalKey,
            tuning: data.tuning,
            strummingPattern: data.strummingPattern,
            capo: data.capo,
            cloudUrl: req.file ? cloudUrl : existing.cloudUrl,
            updatedAt: BigInt(Date.now()),
            version: existing.version + 1
        };
        if (req.file)
            Object.assign(updateData, (0, fileMetadata_1.fileMetadata)(cloudUrl, req.file.mimetype), { fileVersion: existing.fileVersion + 1 });
        if (data.isPublic !== undefined) {
            updateData.isPublic = data.isPublic === 'true' || data.isPublic === true;
        }
        if (data.dateAdded)
            updateData.dateAdded = BigInt(data.dateAdded);
        const song = await prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.song.update({ where: { id }, data: updateData });
            await (0, syncService_1.recordChange)(tx, userId, 'song', id, updated.version, 'upsert');
            return updated;
        });
        res.json(JSON.parse(JSON.stringify(song, (key, value) => typeof value === 'bigint' ? value.toString() : value)));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update song' });
    }
};
exports.updateSong = updateSong;
const deleteSong = async (req, res) => {
    const userId = req.userId;
    const id = req.params.id;
    try {
        const existing = await prisma_1.prisma.song.findUnique({ where: { id } });
        if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
            return res.status(404).json({ error: 'Song not found' });
        }
        const now = Date.now();
        await prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.song.update({ where: { id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: existing.version + 1, isPublic: false } });
            await (0, syncService_1.recordChange)(tx, userId, 'song', id, updated.version, 'delete', now);
        });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete song' });
    }
};
exports.deleteSong = deleteSong;
