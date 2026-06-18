import { Router } from 'express';
import { getSongs, createSong, updateSong, deleteSong } from '../controllers/songController';
import { authenticate } from '../middleware/authMiddleware';
import { upload } from '../utils/upload';

const router = Router();

router.use(authenticate); // Require authentication for all song routes

router.get('/', getSongs);
router.post('/', upload.single('file'), createSong);
router.put('/:id', upload.single('file'), updateSong);
router.delete('/:id', deleteSong);

export default router;
