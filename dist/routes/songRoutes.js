"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const songController_1 = require("../controllers/songController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const upload_1 = require("../utils/upload");
const router = (0, express_1.Router)();
router.use(authMiddleware_1.authenticate); // Require authentication for all song routes
router.get('/', songController_1.getSongs);
router.post('/', upload_1.upload.single('file'), songController_1.createSong);
router.put('/:id', upload_1.upload.single('file'), songController_1.updateSong);
router.delete('/:id', songController_1.deleteSong);
exports.default = router;
