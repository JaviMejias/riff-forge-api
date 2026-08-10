"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeUploadPath = safeUploadPath;
exports.fileMetadata = fileMetadata;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function safeUploadPath(cloudUrl) {
    if (typeof cloudUrl !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(cloudUrl))
        return null;
    return path_1.default.join(__dirname, '../../uploads', path_1.default.basename(cloudUrl));
}
function fileMetadata(cloudUrl, mimeType) {
    const filePath = safeUploadPath(cloudUrl);
    if (!filePath || !fs_1.default.existsSync(filePath))
        return { fileHash: null, fileSize: null, fileMimeType: mimeType || null };
    const contents = fs_1.default.readFileSync(filePath);
    return { fileHash: crypto_1.default.createHash('sha256').update(contents).digest('hex'), fileSize: BigInt(contents.length), fileMimeType: mimeType || null };
}
