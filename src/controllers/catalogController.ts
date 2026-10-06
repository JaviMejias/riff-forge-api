import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { invalidInput } from '../services/inputValidation';
import { HttpError } from '../services/httpError';
import { recordRequestError } from '../middleware/requestDiagnostics';
import { catalogDownloadName, resolveCatalogFile } from '../services/catalogFiles';

const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 2147483647;

export const searchCatalog = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q = '', page = '1', limit = '50' } = req.query;
    if (typeof q !== 'string') invalidInput('q');
    if (typeof page !== 'string' || !/^[1-9]\d*$/.test(page)) invalidInput('page');
    if (typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit)) invalidInput('limit');
    const query = q.trim();
    const queryWithUnderscores = query.replace(/\s+/g, '_');
    const pageNum = Number(page);
    const limitNum = Number(limit);
    if (!Number.isSafeInteger(pageNum) || pageNum > MAX_OFFSET) invalidInput('page');
    if (!Number.isInteger(limitNum) || limitNum > MAX_PAGE_SIZE) invalidInput('limit');

    const skip = (pageNum - 1) * limitNum;
    if (!Number.isSafeInteger(skip) || skip > MAX_OFFSET) invalidInput('page');

    // Search by title or artist using contains. Support both spaces and underscores.
    const whereClause = query ? {
      OR: [
        { title: { contains: query } },
        { title: { contains: queryWithUnderscores } },
        { artist: { contains: query } },
        { artist: { contains: queryWithUnderscores } }
      ]
    } : {};

    const [total, tabs] = await Promise.all([
      prisma.catalogTab.count({ where: whereClause }),
      prisma.catalogTab.findMany({
        where: whereClause,
        skip,
        take: limitNum,
        orderBy: [
          { artist: 'asc' },
          { title: 'asc' }
        ]
      })
    ]);

    res.json({
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      tabs
    });

  } catch (error) {
    if (error instanceof HttpError) return next(error);
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to search catalog' });
  }
};

export const downloadCatalogTab = async (req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
  try {
    const id = String(req.params.id);
    const tab = await prisma.catalogTab.findUnique({ where: { id } });

    if (!tab) {
      return res.status(404).json({ error: 'Tab no encontrada en el catálogo' });
    }

    const absolutePath = await resolveCatalogFile(tab.filePath, tab.format);
    if (!absolutePath) {
      return res.status(404).json({ error: 'El archivo físico no existe en el servidor' });
    }

    res.download(absolutePath, catalogDownloadName(tab.artist, tab.title, tab.format), { cacheControl: false, dotfiles: 'deny' }, error => {
      if (!error) return;
      if (res.headersSent) return next(error);
      // Transfer headers must not describe the JSON error body after an asynchronous failure.
      for (const header of ['Content-Disposition', 'Content-Length', 'Content-Type', 'Content-Encoding', 'ETag', 'Last-Modified']) res.removeHeader(header);
      const failure = error as NodeJS.ErrnoException & { status?: number };
      if (failure.status === 416) return next(new HttpError(416, 'Rango de archivo inválido'));
      res.removeHeader('Content-Range');
      if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR' || failure.status === 404) {
        return next(new HttpError(404, 'El archivo físico no existe en el servidor'));
      }
      recordRequestError(res, error);
      res.status(500).json({ error: 'Failed to download tab' });
    });

  } catch (error) {
    if (error instanceof HttpError) return next(error);
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to download tab' });
  }
};
