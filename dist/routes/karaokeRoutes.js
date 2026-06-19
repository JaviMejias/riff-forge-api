"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const karaokeController_1 = require("../controllers/karaokeController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const upload_1 = require("../utils/upload");
const router = (0, express_1.Router)();
// Public route — only lyrics are public (no API quota or disk risk)
router.get('/lyrics', karaokeController_1.fetchLyrics);
// All other routes require authentication
router.use(authMiddleware_1.authenticate);
router.post('/download-audio', karaokeController_1.downloadAudio); // BE-4 fix: was unprotected
router.get('/', karaokeController_1.getKaraokes);
router.post('/', upload_1.upload.single('file'), karaokeController_1.createKaraoke);
router.put('/:id', upload_1.upload.single('file'), karaokeController_1.updateKaraoke);
router.delete('/:id', karaokeController_1.deleteKaraoke);
router.post('/process-pitch', karaokeController_1.processPitch);
exports.default = router;
