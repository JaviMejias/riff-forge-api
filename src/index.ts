import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

import authRoutes from './routes/authRoutes';
import songRoutes from './routes/songRoutes';
import karaokeRoutes from './routes/karaokeRoutes';
import playlistRoutes from './routes/playlistRoutes';

import youtubeRoutes from './routes/youtubeRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Allow unlimited JSON payload for sync
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/karaokes', karaokeRoutes);
app.use('/api', playlistRoutes);
app.use('/api/youtube', youtubeRoutes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Riff Forge API is running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
