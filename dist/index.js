"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const songRoutes_1 = __importDefault(require("./routes/songRoutes"));
const karaokeRoutes_1 = __importDefault(require("./routes/karaokeRoutes"));
const playlistRoutes_1 = __importDefault(require("./routes/playlistRoutes"));
const youtubeRoutes_1 = __importDefault(require("./routes/youtubeRoutes"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Allow unlimited JSON payload for sync
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve uploaded files statically
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Routes
app.use('/api/auth', authRoutes_1.default);
app.use('/api/songs', songRoutes_1.default);
app.use('/api/karaokes', karaokeRoutes_1.default);
app.use('/api', playlistRoutes_1.default);
app.use('/api/youtube', youtubeRoutes_1.default);
// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
