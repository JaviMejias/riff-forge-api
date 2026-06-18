"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const playlistController_1 = require("../controllers/playlistController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = (0, express_1.Router)();
router.use(authMiddleware_1.authenticate);
// Playlists
router.get('/playlists', playlistController_1.getPlaylists);
router.post('/playlists/sync', playlistController_1.savePlaylists);
// Karaoke Playlists
router.get('/karaoke-playlists', playlistController_1.getKaraokePlaylists);
router.post('/karaoke-playlists/sync', playlistController_1.saveKaraokePlaylists);
// Custom Chords
router.get('/chords', playlistController_1.getCustomChords);
router.post('/chords/sync', playlistController_1.saveCustomChords);
exports.default = router;
