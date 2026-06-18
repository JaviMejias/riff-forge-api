import { Router } from 'express';
import { getPlaylists, savePlaylists, getKaraokePlaylists, saveKaraokePlaylists, getCustomChords, saveCustomChords } from '../controllers/playlistController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticate);

// Playlists
router.get('/playlists', getPlaylists);
router.post('/playlists/sync', savePlaylists);

// Karaoke Playlists
router.get('/karaoke-playlists', getKaraokePlaylists);
router.post('/karaoke-playlists/sync', saveKaraokePlaylists);

// Custom Chords
router.get('/chords', getCustomChords);
router.post('/chords/sync', saveCustomChords);

export default router;
