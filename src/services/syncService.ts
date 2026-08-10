import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const ENTITY_TYPES = ['song', 'karaoke', 'custom_chord', 'playlist', 'karaoke_playlist'] as const;
export type EntityType = typeof ENTITY_TYPES[number];
type Tx = Prisma.TransactionClient | any;

export interface SyncOperation {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  action: 'upsert' | 'delete';
  baseVersion: number;
  clientUpdatedAt?: number;
  data?: Record<string, unknown>;
}

const editableFields: Record<EntityType, string[]> = {
  song: ['name', 'artist', 'album', 'type', 'textContent', 'originalKey', 'tuning', 'strummingPattern', 'capo', 'isPublic', 'dateAdded'],
  karaoke: ['name', 'artist', 'youtubeUrl', 'hasLocalAudio', 'pitchShift', 'textContent', 'isPublic', 'dateAdded'],
  custom_chord: ['name', 'root', 'frets', 'fingers', 'baseFret', 'barres', 'isPublic'],
  playlist: ['name', 'songCloudIds', 'isPublic'],
  karaoke_playlist: ['name', 'karaokeCloudIds', 'isPublic']
};

const cursorSecret = process.env.JWT_SECRET || 'development-only';

export function encodeCursor(sequence: number): string {
  const value = String(sequence);
  const signature = crypto.createHmac('sha256', cursorSecret).update(value).digest('base64url');
  return Buffer.from(`${value}.${signature}`).toString('base64url');
}

export function decodeCursor(cursor: unknown): number {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  if (typeof cursor !== 'string' || cursor.length > 256) throw new Error('invalid_cursor');
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString();
    const [value, signature] = decoded.split('.');
    const expected = crypto.createHmac('sha256', cursorSecret).update(value).digest('base64url');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error();
    return sequence;
  } catch (_) {
    throw new Error('invalid_cursor');
  }
}

export function publicEntity(entityType: EntityType, entity: any) {
  if (!entity) return null;
  const common: any = {};
  for (const key of editableFields[entityType]) {
    if (key.endsWith('CloudIds')) {
      try { common[key] = JSON.parse(entity[key] || '[]'); } catch (_) { common[key] = []; }
    } else if (entity[key] !== undefined) {
      common[key] = typeof entity[key] === 'bigint' ? Number(entity[key]) : entity[key];
    }
  }
  if (entityType === 'song' || entityType === 'karaoke') {
    common.file = entity.cloudUrl ? {
      url: entity.cloudUrl,
      version: entity.fileVersion,
      hash: entity.fileHash,
      size: entity.fileSize === null ? null : Number(entity.fileSize),
      mimeType: entity.fileMimeType
    } : null;
  }
  return {
    entityType,
    entityId: entity.id,
    version: entity.version,
    createdAt: Number(entity.createdAt),
    updatedAt: Number(entity.updatedAt),
    deletedAt: entity.deletedAt === null ? null : Number(entity.deletedAt),
    data: common
  };
}

function model(tx: Tx, entityType: EntityType): any {
  return (tx as any)[({ custom_chord: 'customChord', karaoke_playlist: 'karaokePlaylist' } as any)[entityType] || entityType];
}

export async function findOwned(tx: Tx, entityType: EntityType, entityId: string, userId: string) {
  return model(tx, entityType).findFirst({ where: { id: entityId, userId } });
}

async function playlistIds(tx: Tx, userId: string, type: EntityType, data: Record<string, unknown>) {
  const field = type === 'playlist' ? 'songCloudIds' : 'karaokeCloudIds';
  const target: any = type === 'playlist' ? tx.song : tx.karaoke;
  const raw = data[field];
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) throw new Error('validation_error');
  const unique = Array.from(new Set(raw as string[]));
  const owned: Array<{ id: string }> = await target.findMany({ where: { id: { in: unique }, userId, deletedAt: null }, select: { id: true } });
  const valid = new Set(owned.map((item: { id: string }) => item.id));
  if (unique.some(id => !valid.has(id))) throw new Error('forbidden_reference');
  return { [field]: JSON.stringify(raw) };
}

function sanitized(type: EntityType, data: Record<string, unknown>) {
  const result: any = {};
  for (const key of editableFields[type]) if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
  if ('dateAdded' in result) result.dateAdded = BigInt(Number(result.dateAdded));
  if (type === 'custom_chord') {
    for (const key of ['frets', 'fingers', 'barres']) if (key in result && typeof result[key] !== 'string') result[key] = JSON.stringify(result[key]);
    if ('baseFret' in result) result.baseFret = Number(result.baseFret);
  }
  return result;
}

export async function recordChange(tx: Tx, userId: string, entityType: EntityType, entityId: string, version: number, action: 'upsert' | 'delete', now = Date.now()) {
  const entity = await findOwned(tx, entityType, entityId, userId);
  const payload = entity ? JSON.stringify(publicEntity(entityType, entity)) : null;
  return tx.syncChange.create({ data: { userId, entityType, entityId, version, action, payload, createdAt: BigInt(now) } });
}

export async function applyOperation(tx: Tx, userId: string, operation: SyncOperation) {
  const existing = await findOwned(tx, operation.entityType, operation.entityId, userId);
  if (!existing) {
    const foreign = await model(tx, operation.entityType).findUnique({ where: { id: operation.entityId }, select: { userId: true } });
    if (foreign) return { accepted: false, reason: 'forbidden', serverEntity: null };
  }
  if (existing && existing.deletedAt !== null) return { accepted: false, reason: 'conflict', serverEntity: publicEntity(operation.entityType, existing) };
  if (existing && operation.baseVersion !== existing.version) return { accepted: false, reason: 'conflict', serverEntity: publicEntity(operation.entityType, existing) };
  if (!existing && operation.action === 'delete') return { accepted: false, reason: 'not_found', serverEntity: null };
  if (!existing && operation.baseVersion !== 0) return { accepted: false, reason: 'conflict', serverEntity: null };

  const now = Date.now();
  const nextVersion = existing ? existing.version + 1 : 1;
  if (operation.action === 'delete') {
    const entity = await model(tx, operation.entityType).update({ where: { id: operation.entityId }, data: { deletedAt: BigInt(now), updatedAt: BigInt(now), version: nextVersion, isPublic: false } });
    await recordChange(tx, userId, operation.entityType, operation.entityId, nextVersion, 'delete', now);
    return { accepted: true, serverEntity: publicEntity(operation.entityType, entity) };
  }

  const input = operation.data || {};
  let data: any = sanitized(operation.entityType, input);
  if (operation.entityType === 'playlist' || operation.entityType === 'karaoke_playlist') data = { ...data, ...(await playlistIds(tx, userId, operation.entityType, input)) };
  if (!existing && typeof data.name !== 'string') return { accepted: false, reason: 'validation_error', serverEntity: null };
  if (!existing && operation.entityType === 'custom_chord' && (!data.root || !data.frets || !data.fingers || !Number.isInteger(data.baseFret))) return { accepted: false, reason: 'validation_error', serverEntity: null };
  const timestamps = { updatedAt: BigInt(now), version: nextVersion };
  const createData: any = { ...data, ...timestamps, id: operation.entityId, userId, createdAt: BigInt(now) };
  if (operation.entityType === 'song' || operation.entityType === 'karaoke') createData.dateAdded = data.dateAdded || BigInt(now);
  const entity = existing
    ? await model(tx, operation.entityType).update({ where: { id: operation.entityId }, data: { ...data, ...timestamps } })
    : await model(tx, operation.entityType).create({ data: createData });
  await recordChange(tx, userId, operation.entityType, operation.entityId, nextVersion, 'upsert', now);
  return { accepted: true, serverEntity: publicEntity(operation.entityType, entity) };
}

export async function changesAfter(prisma: PrismaClient | any, userId: string, cursor: number, limit: number) {
  const rows = await prisma.syncChange.findMany({ where: { userId, sequence: { gt: cursor } }, orderBy: { sequence: 'asc' }, take: limit + 1 });
  const included = rows.slice(0, limit);
  const changes = [];
  for (const row of included) {
    if (row.payload) changes.push(JSON.parse(row.payload));
    else {
      const entity = await findOwned(prisma as any, row.entityType as EntityType, row.entityId, userId);
      if (entity) changes.push(publicEntity(row.entityType as EntityType, entity));
    }
  }
  return { changes, nextSequence: included.length ? included[included.length - 1].sequence : cursor, hasMore: rows.length > limit };
}
