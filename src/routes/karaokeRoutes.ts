import { Router } from 'express';
import { getKaraokes, createKaraoke, updateKaraoke, deleteKaraoke, downloadAudio, fetchLyrics, processPitch } from '../controllers/karaokeController';
import { authenticate } from '../middleware/authMiddleware';
import { upload } from '../utils/upload';

const router = Router();

// Public route — only lyrics are public (no API quota or disk risk)
router.get('/lyrics', fetchLyrics);

// All other routes require authentication
router.use(authenticate);
router.post('/download-audio', downloadAudio);  // BE-4 fix: was unprotected
router.get('/', getKaraokes);
router.post('/', upload.single('file'), createKaraoke);
router.put('/:id', upload.single('file'), updateKaraoke);
router.delete('/:id', deleteKaraoke);
router.post('/process-pitch', processPitch);

export default router;
