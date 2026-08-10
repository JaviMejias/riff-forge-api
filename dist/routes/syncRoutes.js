"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../middleware/authMiddleware");
const syncController_1 = require("../controllers/syncController");
const router = (0, express_1.Router)();
router.post('/v2', (req, res, next) => {
    const size = Number(req.headers['content-length'] || 0);
    if (size > 1024 * 1024)
        return res.status(413).json({ error: 'payload_too_large' });
    next();
}, authMiddleware_1.authenticate, syncController_1.syncV2);
exports.default = router;
