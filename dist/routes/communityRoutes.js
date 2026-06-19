"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const communityController_1 = require("../controllers/communityController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = (0, express_1.Router)();
// Require authentication for community routes as well
router.use(authMiddleware_1.authenticate);
router.get('/songs', communityController_1.getPublicSongs);
router.get('/karaokes', communityController_1.getPublicKaraokes);
router.get('/chords', communityController_1.getPublicCustomChords);
exports.default = router;
