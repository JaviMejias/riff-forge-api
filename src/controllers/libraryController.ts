import { NextFunction, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { HttpError } from '../services/httpError';
import { ENTITY_TYPES, EntityType, publicEntity } from '../services/syncService';
import { Pagination, pageResult, parsePagination } from '../services/pagination';

async function findLibraryRows(entityType: EntityType, userId: string, pagination: Pagination) {
  const args = {
    where: { userId, deletedAt: null },
    orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }],
    skip: pagination.skip,
    take: pagination.limit + 1
  };
  switch (entityType) {
    case 'song': return prisma.song.findMany(args);
    case 'karaoke': return prisma.karaoke.findMany(args);
    case 'custom_chord': return prisma.customChord.findMany(args);
    case 'playlist': return prisma.playlist.findMany(args);
    case 'karaoke_playlist': return prisma.karaokePlaylist.findMany(args);
  }
}

export const getLibraryPage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityType = ENTITY_TYPES.find(type => type === req.params.entityType);
    if (!entityType) throw new HttpError(404, 'Tipo de biblioteca no encontrado');
    const pagination = parsePagination(req.query);
    const rows = await findLibraryRows(entityType, req.userId!, pagination);
    const result = pageResult(rows.map(row => publicEntity(entityType, row)), pagination);
    // A partial page must never carry the token used to replace a whole collection.
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    res.json(result);
  } catch (error) {
    next(error);
  }
};
