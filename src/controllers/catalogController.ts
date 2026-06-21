import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import path from 'path';
import fs from 'fs';

export const searchCatalog = async (req: Request, res: Response) => {
  try {
    const { q = '', page = '1', limit = '50' } = req.query;
    const query = String(q).trim();
    const queryWithUnderscores = query.replace(/\s+/g, '_');
    const pageNum = parseInt(String(page), 10) || 1;
    const limitNum = parseInt(String(limit), 10) || 50;

    const skip = (pageNum - 1) * limitNum;

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
    console.error('Error searching catalog:', error);
    res.status(500).json({ error: 'Failed to search catalog' });
  }
};

export const downloadCatalogTab = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const tab = await prisma.catalogTab.findUnique({ where: { id } });

    if (!tab) {
      return res.status(404).json({ error: 'Tab no encontrada en el catálogo' });
    }

    // The filePath is stored relative to the data directory
    const absolutePath = path.join(__dirname, '../../data', tab.filePath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'El archivo físico no existe en el servidor' });
    }

    // Set headers to force download and set correct filename
    res.download(absolutePath, `${tab.artist} - ${tab.title}.${tab.format}`);

  } catch (error) {
    console.error('Error downloading catalog tab:', error);
    res.status(500).json({ error: 'Failed to download tab' });
  }
};
