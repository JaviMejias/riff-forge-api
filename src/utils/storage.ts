import path from 'path';

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
export const catalogDataDir = path.resolve(process.env.CATALOG_DATA_DIR || path.join(__dirname, '../../data'));
