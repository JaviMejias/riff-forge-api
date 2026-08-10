"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCustomChords = exports.getCustomChords = exports.saveKaraokePlaylists = exports.getKaraokePlaylists = exports.savePlaylists = exports.getPlaylists = void 0;
const prisma_1 = require("../utils/prisma");
const syncService_1 = require("../services/syncService");
const serialize = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const asBoolean = (value) => value === true || value === 'true';
const asJson = (value, fallback = []) => typeof value === 'string' ? value : JSON.stringify(value || fallback);
async function ownedIds(tx, userId, modelName, ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
        throw new Error('invalid_references');
    const unique = Array.from(new Set(ids));
    const rows = await tx[modelName].findMany({ where: { userId, id: { in: unique }, deletedAt: null }, select: { id: true } });
    if (rows.length !== unique.length)
        throw new Error('invalid_references');
    return ids;
}
const getPlaylists = async (req, res) => {
    try {
        const playlists = await prisma_1.prisma.playlist.findMany({ where: { userId: req.userId, deletedAt: null } });
        const mapped = await Promise.all(playlists.map(async (playlist) => {
            const songCloudIds = JSON.parse(playlist.songCloudIds || '[]');
            const rows = await prisma_1.prisma.song.findMany({ where: { userId: req.userId, id: { in: songCloudIds }, deletedAt: null } });
            const byId = new Map(rows.map(song => [song.id, song]));
            return { ...playlist, songCloudIds: songCloudIds.filter(id => byId.has(id)), songs: songCloudIds.map(id => byId.get(id)).filter(Boolean) };
        }));
        res.json(serialize(mapped));
    }
    catch (_) {
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
};
exports.getPlaylists = getPlaylists;
const savePlaylists = async (req, res) => saveCollection(req, res, 'playlist');
exports.savePlaylists = savePlaylists;
const getKaraokePlaylists = async (req, res) => {
    try {
        const playlists = await prisma_1.prisma.karaokePlaylist.findMany({ where: { userId: req.userId, deletedAt: null } });
        const mapped = await Promise.all(playlists.map(async (playlist) => {
            const karaokeCloudIds = JSON.parse(playlist.karaokeCloudIds || '[]');
            const rows = await prisma_1.prisma.karaoke.findMany({ where: { userId: req.userId, id: { in: karaokeCloudIds }, deletedAt: null } });
            const byId = new Map(rows.map(karaoke => [karaoke.id, karaoke]));
            return { ...playlist, karaokeCloudIds: karaokeCloudIds.filter(id => byId.has(id)), karaokes: karaokeCloudIds.map(id => byId.get(id)).filter(Boolean) };
        }));
        res.json(serialize(mapped));
    }
    catch (_) {
        res.status(500).json({ error: 'Failed to fetch karaoke playlists' });
    }
};
exports.getKaraokePlaylists = getKaraokePlaylists;
const saveKaraokePlaylists = async (req, res) => saveCollection(req, res, 'karaokePlaylist');
exports.saveKaraokePlaylists = saveKaraokePlaylists;
async function saveCollection(req, res, kind) {
    const userId = req.userId;
    if (!Array.isArray(req.body))
        return res.status(400).json({ error: `Expected an array of ${kind}s` });
    try {
        await prisma_1.prisma.$transaction(async (tx) => {
            const now = Date.now();
            const entityType = kind === 'playlist' ? 'playlist' : 'karaoke_playlist';
            const ids = req.body.map((item) => item.id);
            const existing = await tx[kind].findMany({ where: { userId } });
            for (const old of existing) {
                if (!ids.includes(old.id) && old.deletedAt === null) {
                    const deleted = await tx[kind].update({ where: { id: old.id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: old.version + 1, isPublic: false } });
                    await (0, syncService_1.recordChange)(tx, userId, entityType, old.id, deleted.version, 'delete', now);
                }
            }
            for (const item of req.body) {
                if (!item || typeof item.id !== 'string' || typeof item.name !== 'string')
                    throw new Error('validation_error');
                const old = existing.find((entry) => entry.id === item.id);
                if (old && old.deletedAt !== null)
                    throw new Error('deleted_conflict');
                const listField = kind === 'playlist' ? 'songCloudIds' : 'karaokeCloudIds';
                const refs = await ownedIds(tx, userId, kind === 'playlist' ? 'song' : 'karaoke', item[listField] || []);
                const data = { name: item.name, [listField]: JSON.stringify(refs), isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
                const saved = old ? await tx[kind].update({ where: { id: item.id }, data }) : await tx[kind].create({ data: { ...data, id: item.id, userId, createdAt: BigInt(item.createdAt || now) } });
                await (0, syncService_1.recordChange)(tx, userId, entityType, item.id, saved.version, 'upsert', now);
            }
        });
        res.json({ success: true });
    }
    catch (error) {
        const status = ['validation_error', 'invalid_references', 'deleted_conflict'].includes(error.message) ? 400 : 500;
        res.status(status).json({ error: error.message === 'deleted_conflict' ? 'Deleted entities cannot be restored' : `Failed to save ${kind}s` });
    }
}
const getCustomChords = async (req, res) => {
    try {
        const chords = await prisma_1.prisma.customChord.findMany({ where: { userId: req.userId, deletedAt: null } });
        res.json(serialize(chords));
    }
    catch (_) {
        res.status(500).json({ error: 'Failed to fetch chords' });
    }
};
exports.getCustomChords = getCustomChords;
const saveCustomChords = async (req, res) => {
    const userId = req.userId;
    if (!Array.isArray(req.body))
        return res.status(400).json({ error: 'Expected an array of chords' });
    try {
        await prisma_1.prisma.$transaction(async (tx) => {
            const now = Date.now();
            const ids = req.body.map((item) => item.id);
            const existing = await tx.customChord.findMany({ where: { userId } });
            for (const old of existing) {
                if (!ids.includes(old.id) && old.deletedAt === null) {
                    const deleted = await tx.customChord.update({ where: { id: old.id }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: old.version + 1, isPublic: false } });
                    await (0, syncService_1.recordChange)(tx, userId, 'custom_chord', old.id, deleted.version, 'delete', now);
                }
            }
            for (const item of req.body) {
                if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.root !== 'string' || !Number.isInteger(Number(item.baseFret)))
                    throw new Error('validation_error');
                const old = existing.find((entry) => entry.id === item.id);
                if (old && old.deletedAt !== null)
                    throw new Error('deleted_conflict');
                const data = { name: item.name, root: item.root, frets: asJson(item.frets), fingers: asJson(item.fingers), baseFret: Number(item.baseFret), barres: asJson(item.barres), isPublic: asBoolean(item.isPublic), updatedAt: BigInt(now), version: old ? old.version + 1 : 1 };
                const saved = old ? await tx.customChord.update({ where: { id: item.id }, data }) : await tx.customChord.create({ data: { ...data, id: item.id, userId, createdAt: BigInt(now) } });
                await (0, syncService_1.recordChange)(tx, userId, 'custom_chord', item.id, saved.version, 'upsert', now);
            }
        });
        res.json({ success: true });
    }
    catch (error) {
        res.status(['validation_error', 'deleted_conflict'].includes(error.message) ? 400 : 500).json({ error: 'Failed to save custom chords' });
    }
};
exports.saveCustomChords = saveCustomChords;
