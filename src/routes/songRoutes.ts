import { Router } from 'express';
import { getSongs, createSong, updateSong, deleteSong } from '../controllers/songController';
import { authenticate } from '../middleware/authMiddleware';
import { songUpload } from '../utils/upload';

const router = Router();

router.use(authenticate); // Require authentication for all song routes

router.get('/', getSongs);
router.post('/', songUpload.single('file'), createSong);
router.put('/:id', songUpload.single('file'), updateSong);
router.delete('/:id', deleteSong);

export default router;
