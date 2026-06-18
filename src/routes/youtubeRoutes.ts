import { Router } from 'express';
import { extractAudio } from '../controllers/youtubeController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticate);

router.post('/extract', extractAudio);

export default router;
