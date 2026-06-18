import { Router } from 'express';
import { getKaraokes, createKaraoke, updateKaraoke, deleteKaraoke, downloadAudio, fetchLyrics, processPitch } from '../controllers/karaokeController';
import { authenticate } from '../middleware/authMiddleware';
import { upload } from '../utils/upload';

const router = Router();

// Public routes for proxying
router.get('/lyrics', fetchLyrics);
router.post('/download-audio', downloadAudio);

router.use(authenticate);
router.get('/', getKaraokes);
router.post('/', upload.single('file'), createKaraoke);
router.put('/:id', upload.single('file'), updateKaraoke);
router.delete('/:id', deleteKaraoke);
router.post('/process-pitch', processPitch);

export default router;
