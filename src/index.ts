import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/authRoutes';
import songRoutes from './routes/songRoutes';
import karaokeRoutes from './routes/karaokeRoutes';
import playlistRoutes from './routes/playlistRoutes';

import youtubeRoutes from './routes/youtubeRoutes';
import communityRoutes from './routes/communityRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Allow unlimited JSON payload for sync
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
  max: 20, // limit each IP to 20 login/signup requests per hour
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

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});

// Global error handler (M-10 fix)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Error:', err.stack || err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
