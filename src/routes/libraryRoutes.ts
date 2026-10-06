import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { getLibraryPage } from '../controllers/libraryController';

const router = Router();
router.use(authenticate);
router.get('/:entityType', getLibraryPage);

export default router;
