import { Router } from 'express';
import { getKaraokes, createKaraoke, updateKaraoke, deleteKaraoke, downloadAudio, fetchLyrics, processPitch, getYouTubeMetadata, deleteAudio } from '../controllers/karaokeController';
import { authenticate } from '../middleware/authMiddleware';
import { karaokeUpload } from '../utils/upload';

const router = Router();

// Public route — only lyrics are public (no API quota or disk risk)
router.get('/lyrics', fetchLyrics);

// All other routes require authentication
router.use(authenticate);
router.get('/youtube-metadata', getYouTubeMetadata);
router.post('/download-audio', downloadAudio);  // BE-4 fix: was unprotected
router.post('/delete-audio', deleteAudio);
router.get('/', getKaraokes);
router.post('/', karaokeUpload.single('file'), createKaraoke);
router.put('/:id', karaokeUpload.single('file'), updateKaraoke);
router.delete('/:id', deleteKaraoke);
router.post('/process-pitch', processPitch);

export default router;
