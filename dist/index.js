"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const songRoutes_1 = __importDefault(require("./routes/songRoutes"));
const karaokeRoutes_1 = __importDefault(require("./routes/karaokeRoutes"));
const playlistRoutes_1 = __importDefault(require("./routes/playlistRoutes"));
const youtubeRoutes_1 = __importDefault(require("./routes/youtubeRoutes"));
const communityRoutes_1 = __importDefault(require("./routes/communityRoutes"));
const catalogRoutes_1 = __importDefault(require("./routes/catalogRoutes"));
const syncRoutes_1 = __importDefault(require("./routes/syncRoutes"));
exports.app = (0, express_1.default)();
exports.app.set('trust proxy', 1); // Trust first proxy (Nginx/Cloudflare) to get real client IPs for rate limiting
const PORT = process.env.PORT || 3001;
// M-8 fix: add helmet security headers
// Since we are serving audio files across origins to our frontend, we need to allow cross-origin resource sharing
exports.app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
// Allow unlimited JSON payload for sync
exports.app.use((0, cors_1.default)());
exports.app.use(express_1.default.json({ limit: '50mb' }));
exports.app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve uploaded files statically
exports.app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Rate limiting configurations (BE-9 fix)
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { error: 'Too many requests, please try again later' }
});
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // limit each IP to 100 login/signup requests per hour (increased to prevent blocking)
    message: { error: 'Too many authentication attempts, please try again later' }
});
exports.app.use(generalLimiter);
// Routes
exports.app.use('/api/auth', authLimiter, authRoutes_1.default);
exports.app.use('/api/songs', songRoutes_1.default);
exports.app.use('/api/karaokes', karaokeRoutes_1.default);
exports.app.use('/api', playlistRoutes_1.default);
exports.app.use('/api/youtube', youtubeRoutes_1.default);
exports.app.use('/api/community', communityRoutes_1.default);
exports.app.use('/api/catalog', catalogRoutes_1.default);
exports.app.use('/api/sync', syncRoutes_1.default);
// Health check
exports.app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});
// Global error handler (M-10 fix)
exports.app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack || err);
    res.status(500).json({ error: 'Internal Server Error' });
});
if (require.main === module) {
    exports.app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}
