"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const songRoutes_1 = __importDefault(require("./routes/songRoutes"));
const karaokeRoutes_1 = __importDefault(require("./routes/karaokeRoutes"));
const playlistRoutes_1 = __importDefault(require("./routes/playlistRoutes"));
const youtubeRoutes_1 = __importDefault(require("./routes/youtubeRoutes"));
const communityRoutes_1 = __importDefault(require("./routes/communityRoutes"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// M-8 fix: add helmet security headers
// Since we are serving audio files across origins to our frontend, we need to allow cross-origin resource sharing
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
// Allow unlimited JSON payload for sync
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve uploaded files statically
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Rate limiting configurations (BE-9 fix)
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { error: 'Too many requests, please try again later' }
});
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // limit each IP to 20 login/signup requests per hour
    message: { error: 'Too many authentication attempts, please try again later' }
});
app.use(generalLimiter);
// Routes
app.use('/api/auth', authLimiter, authRoutes_1.default);
app.use('/api/songs', songRoutes_1.default);
app.use('/api/karaokes', karaokeRoutes_1.default);
app.use('/api', playlistRoutes_1.default);
app.use('/api/youtube', youtubeRoutes_1.default);
app.use('/api/community', communityRoutes_1.default);
// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});
// Global error handler (M-10 fix)
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack || err);
    res.status(500).json({ error: 'Internal Server Error' });
});
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
