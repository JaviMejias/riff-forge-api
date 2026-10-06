import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { uploadDir } from './storage';
import { HttpError } from '../services/httpError';

// Ensure uploads directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
  }
});

function createUpload(extensions: string[]) {
  const limits = {
    fileSize: 50 * 1024 * 1024, files: 1, fields: 32, parts: 33,
    fieldSize: 1024 * 1024, fieldNameSize: 64, fieldNestingDepth: 0, fieldArrayIndexLimit: 0
  };
  return multer({
    storage,
    limits,
    fileFilter: (_req, file, callback) => {
      if (!extensions.includes(path.extname(file.originalname).toLowerCase())) {
        return callback(new HttpError(400, 'Formato de archivo no permitido'));
      }
      callback(null, true);
    }
  });
}

export const songUpload = createUpload(['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.txt']);
export const karaokeUpload = createUpload(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.aac']);
