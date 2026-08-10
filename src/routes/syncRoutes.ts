import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { syncV2 } from '../controllers/syncController';

const router = Router();
router.post('/v2', (req, res, next) => {
  const size = Number(req.headers['content-length'] || 0);
  if (size > 1024 * 1024) return res.status(413).json({ error: 'payload_too_large' });
  next();
}, authenticate, syncV2);
export default router;
