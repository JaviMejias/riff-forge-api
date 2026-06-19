import { Router } from 'express';
import { getPublicSongs, getPublicKaraokes, getPublicCustomChords } from '../controllers/communityController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

// Require authentication for community routes as well
router.use(authenticate);

router.get('/songs', getPublicSongs);
router.get('/karaokes', getPublicKaraokes);
router.get('/chords', getPublicCustomChords);

export default router;
