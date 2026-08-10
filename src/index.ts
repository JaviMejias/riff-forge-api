import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/authRoutes';
import songRoutes from './routes/songRoutes';
import karaokeRoutes from './routes/karaokeRoutes';
import playlistRoutes from './routes/playlistRoutes';

import youtubeRoutes from './routes/youtubeRoutes';
import communityRoutes from './routes/communityRoutes';
import catalogRoutes from './routes/catalogRoutes';
import syncRoutes from './routes/syncRoutes';

export const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx/Cloudflare) to get real client IPs for rate limiting

const PORT = process.env.PORT || 3001;

// M-8 fix: add helmet security headers
// Since we are serving audio files across origins to our frontend, we need to allow cross-origin resource sharing
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Rate limiting configurations (BE-9 fix)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // limit each IP to 100 login/signup requests per hour (increased to prevent blocking)
  message: { error: 'Too many authentication attempts, please try again later' }
});

app.use(generalLimiter);

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/karaokes', karaokeRoutes);
app.use('/api', playlistRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/sync', syncRoutes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});

// Global error handler (M-10 fix)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Error:', err.stack || err);
  res.status(500).json({ error: 'Internal Server Error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}
