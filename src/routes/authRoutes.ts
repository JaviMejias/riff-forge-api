import { Router } from 'express';
import { signup, login, verifyToken, saveSettings } from '../controllers/authController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/verify', authenticate, verifyToken);
router.post('/settings', authenticate, saveSettings);

export default router;
