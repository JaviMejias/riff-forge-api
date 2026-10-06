import { NextFunction, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { pageResult, paginationHeaders, parsePagination } from '../services/pagination';

const serializeBigInts = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? item.toString() : item
));

export const getPublicSongs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query);
    const songs = await prisma.song.findMany({
      where: { isPublic: true, deletedAt: null },
      orderBy: [{ dateAdded: 'desc' }, { id: 'asc' }],
      skip: pagination.skip,
      take: pagination.limit + 1,
      include: { user: { select: { id: true, name: true } } }
    });
    const result = pageResult(songs, pagination);
    res.set(paginationHeaders(result));
    res.json(serializeBigInts(result.items));
  } catch (error) {
    next(error);
  }
};

export const getPublicKaraokes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query);
    const karaokes = await prisma.karaoke.findMany({
      where: { isPublic: true, deletedAt: null },
      orderBy: [{ dateAdded: 'desc' }, { id: 'asc' }],
      skip: pagination.skip,
      take: pagination.limit + 1,
      include: { user: { select: { id: true, name: true } } }
    });
    const result = pageResult(karaokes, pagination);
    res.set(paginationHeaders(result));
    res.json(serializeBigInts(result.items));
  } catch (error) {
    next(error);
  }
};

export const getPublicCustomChords = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query);
    const chords = await prisma.customChord.findMany({
      where: { isPublic: true, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: pagination.skip,
      take: pagination.limit + 1,
      include: { user: { select: { id: true, name: true } } }
    });
    const result = pageResult(chords, pagination);
    res.set(paginationHeaders(result));
    res.json(serializeBigInts(result.items));
  } catch (error) {
    next(error);
  }
};
