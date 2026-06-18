"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const youtubeController_1 = require("../controllers/youtubeController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = (0, express_1.Router)();
router.use(authMiddleware_1.authenticate);
router.post('/extract', youtubeController_1.extractAudio);
exports.default = router;
