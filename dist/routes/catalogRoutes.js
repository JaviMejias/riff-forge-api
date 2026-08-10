"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const catalogController_1 = require("../controllers/catalogController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = (0, express_1.Router)();
// Catalog search is protected to logged in users
router.get('/search', authMiddleware_1.authenticate, catalogController_1.searchCatalog);
// Catalog download is protected as well to prevent abuse
router.get('/:id/download', authMiddleware_1.authenticate, catalogController_1.downloadCatalogTab);
exports.default = router;
