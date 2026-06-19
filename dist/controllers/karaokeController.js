"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLyrics = exports.processPitch = exports.downloadAudio = exports.deleteKaraoke = exports.updateKaraoke = exports.createKaraoke = exports.getKaraokes = void 0;
const prisma_1 = require("../utils/prisma");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const util_1 = __importDefault(require("util"));
const execPromise = util_1.default.promisify(child_process_1.exec);
// Helper to serialize BigInts
const serializeBigInts = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value));
const getKaraokes = async (req, res) => {
    const userId = req.userId;
    try {
        const karaokes = await prisma_1.prisma.karaoke.findMany({ where: { userId } });
        res.json(serializeBigInts(karaokes));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch karaokes' });
    }
};
exports.getKaraokes = getKaraokes;
const createKaraoke = async (req, res) => {
    const userId = req.userId;
    try {
        const data = req.body;
        let cloudUrl = data.cloudUrl;
        if (req.file) {
            cloudUrl = `/uploads/${req.file.filename}`;
        }
        const karaoke = await prisma_1.prisma.karaoke.create({
            data: {
                id: data.id,
                userId,
                name: data.name,
                artist: data.artist,
                youtubeUrl: data.youtubeUrl,
                cloudUrl: cloudUrl,
                hasLocalAudio: req.file ? true : (data.hasLocalAudio === 'true' || data.hasLocalAudio === true),
                pitchShift: data.pitchShift ? parseFloat(data.pitchShift) : null,
                textContent: data.textContent,
                isPublic: data.isPublic === 'true' || data.isPublic === true,
                dateAdded: BigInt(data.dateAdded || Date.now()),
                updatedAt: BigInt(data.updatedAt || Date.now())
            }
        });
        res.json(serializeBigInts(karaoke));
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create karaoke' });
    }
};
exports.createKaraoke = createKaraoke;
const updateKaraoke = async (req, res) => {
    const userId = req.userId;
    const id = req.params.id;
    try {
        const data = req.body;
        let cloudUrl = data.cloudUrl;
        let hasLocalAudio = data.hasLocalAudio;
        if (req.file) {
            cloudUrl = `/uploads/${req.file.filename}`;
            hasLocalAudio = true;
        }
        else {
            hasLocalAudio = hasLocalAudio === 'true' || hasLocalAudio === true;
        }
        const existing = await prisma_1.prisma.karaoke.findUnique({ where: { id } });
        if (!existing || existing.userId !== userId) {
            return res.status(404).json({ error: 'Karaoke not found' });
        }
        const updateData = {
            name: data.name,
            artist: data.artist,
            youtubeUrl: data.youtubeUrl,
            cloudUrl: cloudUrl,
            hasLocalAudio: hasLocalAudio,
            pitchShift: data.pitchShift ? parseFloat(data.pitchShift) : null,
            textContent: data.textContent,
            updatedAt: BigInt(Date.now())
        };
        if (data.isPublic !== undefined) {
            updateData.isPublic = data.isPublic === 'true' || data.isPublic === true;
        }
        if (data.dateAdded)
            updateData.dateAdded = BigInt(data.dateAdded);
        const karaoke = await prisma_1.prisma.karaoke.update({
            where: { id },
            data: updateData
        });
        res.json(serializeBigInts(karaoke));
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update karaoke' });
    }
};
exports.updateKaraoke = updateKaraoke;
const deleteKaraoke = async (req, res) => {
    const userId = req.userId;
    const id = req.params.id;
    try {
        const existing = await prisma_1.prisma.karaoke.findUnique({ where: { id } });
        if (!existing || existing.userId !== userId) {
            return res.status(404).json({ error: 'Karaoke not found' });
        }
        if (existing.cloudUrl) {
            const filePath = path_1.default.join(__dirname, '../../', existing.cloudUrl);
            if (fs_1.default.existsSync(filePath)) {
                fs_1.default.unlinkSync(filePath);
            }
        }
        await prisma_1.prisma.karaoke.delete({ where: { id } });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete karaoke' });
    }
};
exports.deleteKaraoke = deleteKaraoke;
const stream_1 = require("stream");
const downloadAudio = async (req, res) => {
    const { url } = req.body;
    if (!url)
        return res.status(400).json({ error: 'URL is required' });
    let outputPath = '';
    try {
        const filename = `${crypto_1.default.randomUUID()}.mp3`;
        outputPath = path_1.default.join(__dirname, '../../uploads', filename);
        // 1. Extraer ID del video de YouTube
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
        const videoId = match ? match[1] : null;
        if (!videoId) {
            return res.status(400).json({ error: 'URL de YouTube inválida' });
        }
        // 2. Pedir a RapidAPI que genere el MP3
        const apiKey = process.env.RAPIDAPI_KEY;
        if (!apiKey)
            return res.status(500).json({ error: 'RAPIDAPI_KEY no configurada en el servidor' });
        const apiRes = await fetch(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
            headers: {
                'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
                'x-rapidapi-key': apiKey
            }
        });
        if (!apiRes.ok)
            throw new Error(`RapidAPI failed: ${apiRes.status}`);
        const data = await apiRes.json();
        if (data.status !== 'ok' || !data.link) {
            throw new Error(`RapidAPI Error: ${JSON.stringify(data)}`);
        }
        // 3. Descargar el MP3 desde el link generado
        const fileRes = await fetch(data.link);
        if (!fileRes.ok || !fileRes.body) {
            throw new Error(`Failed to download MP3 from RapidAPI link: ${fileRes.status}`);
        }
        // 4. Guardarlo en la carpeta uploads de Oracle Cloud
        const fileStream = fs_1.default.createWriteStream(outputPath);
        const readable = stream_1.Readable.fromWeb(fileRes.body);
        readable.pipe(fileStream);
        await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });
        // 5. Devolver el enlace local
        res.json({ cloudUrl: `/uploads/${filename}` });
    }
    catch (error) {
        console.error('Error downloading audio via RapidAPI:', error);
        // M-11 fix: remove partial file if it failed
        if (fs_1.default.existsSync(outputPath)) {
            try {
                fs_1.default.unlinkSync(outputPath);
            }
            catch (e) {
                console.error('Failed to clean up partial file:', e);
            }
        }
        res.status(500).json({ error: 'Failed to download audio' });
    }
};
exports.downloadAudio = downloadAudio;
const processPitch = async (req, res) => {
    const { cloudUrl, pitchShift } = req.body;
    if (pitchShift === undefined) {
        return res.status(400).json({ error: 'pitchShift is required' });
    }
    if (!cloudUrl || typeof cloudUrl !== 'string' || !cloudUrl.startsWith('/uploads/')) {
        return res.status(400).json({ error: 'Invalid cloudUrl' });
    }
    try {
        const originalPath = path_1.default.join(__dirname, '../../', cloudUrl);
        const uploadsDir = path_1.default.join(__dirname, '../../uploads');
        // Security check to prevent path traversal
        if (!originalPath.startsWith(uploadsDir)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!fs_1.default.existsSync(originalPath)) {
            return res.status(404).json({ error: 'Original audio file not found on server' });
        }
        if (pitchShift === 0) {
            return res.json({ cloudUrl });
        }
        // Determine processed filename and path
        // We base the new filename on the original file name, without the extension
        const baseName = path_1.default.basename(cloudUrl, '.mp3');
        // If baseName already has _pitch_, strip it to get the raw base name
        const rawBaseName = baseName.split('_pitch_')[0];
        const processedFilename = `${rawBaseName}_pitch_${pitchShift}.mp3`;
        const processedPath = path_1.default.join(uploadsDir, processedFilename);
        const processedCloudUrl = `/uploads/${processedFilename}`;
        // If it already exists, return it (caching)
        if (fs_1.default.existsSync(processedPath)) {
            return res.json({ cloudUrl: processedCloudUrl });
        }
        // Run FFMPEG with rubberband filter
        // pitchShift is in semitones. Rubberband 'pitch' parameter is a scale factor.
        // Scale factor = 2 ^ (semitones / 12)
        const pitchRatio = Math.pow(2, pitchShift / 12);
        // We also use formant=preserved for more professional vocal shifting
        const ffmpegCmd = `ffmpeg -i "${originalPath}" -af "rubberband=pitch=${pitchRatio}:formant=preserved" -y "${processedPath}"`;
        await execPromise(ffmpegCmd);
        res.json({ cloudUrl: processedCloudUrl });
    }
    catch (error) {
        console.error('Error processing pitch:', error);
        res.status(500).json({ error: 'Failed to process pitch' });
    }
};
exports.processPitch = processPitch;
const fetchLyrics = async (req, res) => {
    const { title, artist } = req.query;
    if (!title)
        return res.status(400).json({ error: 'Title is required' });
    try {
        const params = new URLSearchParams({
            track_name: title,
            artist_name: artist || ''
        });
        const response = await fetch(`https://lrclib.net/api/search?${params}`, {
            headers: {
                'User-Agent': 'RiffForge/1.0.0 (https://github.com/javier/riff-forge)'
            },
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch from lrclib: ${response.statusText}`);
        }
        const data = await response.json();
        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'No se encontró letra para esta canción.' });
        }
        const firstResult = data[0];
        // Si la API provee letra sincronizada (LRC), la preferimos, si no la plana.
        const lyrics = firstResult.syncedLyrics || firstResult.plainLyrics;
        if (!lyrics) {
            return res.status(404).json({ error: 'No se encontró letra para esta canción.' });
        }
        res.json({ lyrics });
    }
    catch (error) {
        console.error('Error fetching lyrics:', error);
        res.status(500).json({ error: 'Failed to fetch lyrics' });
    }
};
exports.fetchLyrics = fetchLyrics;
