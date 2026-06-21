import { Router } from 'express';
import { searchCatalog, downloadCatalogTab } from '../controllers/catalogController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

// Catalog search is protected to logged in users
router.get('/search', authenticate, searchCatalog);

// Catalog download is protected as well to prevent abuse
router.get('/:id/download', authenticate, downloadCatalogTab);

export default router;
