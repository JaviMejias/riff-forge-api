"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAudio = void 0;
const youtube_dl_exec_1 = __importDefault(require("youtube-dl-exec"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uploadDir = path_1.default.join(__dirname, '../../uploads');
const extractAudio = async (req, res) => {
    const { url } = req.body;
    // BE-7 fix: strict regex to prevent "http://evil.com/?r=youtube.com" bypass
    const isYouTube = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
    if (!url || !isYouTube) {
        return res.status(400).json({ error: 'Valid YouTube URL is required' });
    }
    const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const tempFile = path_1.default.join(uploadDir, `temp-${uniqueId}.webm`); // yt-dlp usually downloads webm/m4a
    const finalFile = path_1.default.join(uploadDir, `yt-${uniqueId}.mp3`);
    const relativeUrl = `/uploads/yt-${uniqueId}.mp3`;
    try {
        // 1. Download best audio
        console.log(`Downloading audio from ${url}...`);
        await (0, youtube_dl_exec_1.default)(url, {
            extractAudio: true,
            audioFormat: 'best',
            output: tempFile,
            noWarnings: true,
            preferFreeFormats: true,
        });
        // 2. Convert to standard MP3 with ffmpeg
        console.log(`Converting to MP3...`);
        await new Promise((resolve, reject) => {
            (0, fluent_ffmpeg_1.default)(tempFile)
                .toFormat('mp3')
                .audioBitrate(192)
                .on('end', () => resolve(true))
                .on('error', (err) => reject(err))
                .save(finalFile);
        });
        // 3. Cleanup temp file
        if (fs_1.default.existsSync(tempFile)) {
            fs_1.default.unlinkSync(tempFile);
        }
        console.log(`Conversion successful: ${relativeUrl}`);
        res.json({ success: true, url: relativeUrl });
    }
    catch (error) {
        console.error('YouTube extraction error:', error);
        if (fs_1.default.existsSync(tempFile))
            fs_1.default.unlinkSync(tempFile);
        if (fs_1.default.existsSync(finalFile))
            fs_1.default.unlinkSync(finalFile);
        res.status(500).json({ error: 'Failed to extract audio from YouTube' });
    }
};
exports.extractAudio = extractAudio;
