import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../utils/prisma';
import { authenticatedUserId } from '../middleware/authMiddleware';
import { safeUploadPath } from '../services/fileMetadata';
import { canReadFile, fileNotFound } from '../services/fileAccess';
import { HttpError } from '../services/httpError';

const router = Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
  next();
});

router.all('/:filename', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    return next(new HttpError(405, 'Método no permitido'));
  }
  try {
    const cloudUrl = `/uploads/${req.params.filename}`;
    const filename = safeUploadPath(cloudUrl);
    if (!filename) throw fileNotFound();
    const userId = authenticatedUserId(req.headers.authorization);
    if (!await canReadFile(prisma, cloudUrl, userId)) throw fileNotFound();
    const stat = await fs.promises.lstat(filename).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw fileNotFound();
    res.attachment(path.basename(filename));
    res.sendFile(filename, { cacheControl: false, dotfiles: 'deny' }, error => {
      if (!error) return;
      if (res.headersSent) return next(error);
      const status = (error as NodeJS.ErrnoException & { status?: number }).status;
      next(status === 416 ? new HttpError(416, 'Rango de archivo inválido') : fileNotFound());
    });
  } catch (error) { next(error); }
});

router.use((_req, _res, next) => next(fileNotFound()));

export default router;
