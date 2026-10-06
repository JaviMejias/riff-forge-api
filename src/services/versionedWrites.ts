import crypto from 'crypto';
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { HttpError } from './httpError';
import { EntityType, findOwned, publicEntity } from './syncService';

interface VersionedEntity {
  id: string;
  userId: string;
  version: number;
  deletedAt: bigint | null;
}

export function versionConflict(entityType: EntityType, entity: VersionedEntity | null) {
  return new HttpError(409, 'Los datos han cambiado; vuelve a sincronizar antes de guardar', {
    code: 'conflict', serverEntity: publicEntity(entityType, entity)
  });
}

function parseVersion(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
    throw new HttpError(400, 'Versión inválida', { code: 'invalid_version' });
  }
  return parsed;
}

export function assertItemVersion(item: { baseVersion?: unknown; version?: unknown }, entityType: EntityType, entity: VersionedEntity) {
  if (entity.deletedAt !== null) throw versionConflict(entityType, entity);
  const values = [item.baseVersion, item.version].filter(value => value !== undefined).map(parseVersion);
  if (values.some(value => value !== values[0])) throw new HttpError(400, 'Las versiones enviadas no coinciden', { code: 'invalid_version' });
  if (values.length && values[0] !== entity.version) throw versionConflict(entityType, entity);
}

export function assertEntityVersion(req: Request, entityType: EntityType, entity: VersionedEntity) {
  if (entity.deletedAt !== null) throw versionConflict(entityType, entity);
  const values: unknown[] = [];
  if (req.body?.baseVersion !== undefined) values.push(req.body.baseVersion);
  if (req.body?.version !== undefined) values.push(req.body.version);
  const header = req.get('If-Match');
  if (header !== undefined) {
    const match = /^"([1-9]\d*)"$/.exec(header);
    if (!match) throw new HttpError(400, 'If-Match debe contener una versión entre comillas', { code: 'invalid_version' });
    values.push(match[1]);
  }
  if (!values.length) {
    throw new HttpError(428, 'Envía baseVersion para modificar este registro', { code: 'version_required' });
  }
  const versions = values.map(parseVersion);
  if (versions.some(value => value !== versions[0])) {
    throw new HttpError(400, 'Las versiones enviadas no coinciden', { code: 'invalid_version' });
  }
  if (versions.length && versions[0] !== entity.version) throw versionConflict(entityType, entity);
}

export async function updateVersioned(tx: Prisma.TransactionClient, entityType: EntityType, existing: VersionedEntity, changes: Record<string, unknown>) {
  const where = { id: existing.id, userId: existing.userId, version: existing.version, deletedAt: null };
  const data = { ...changes, version: { increment: 1 } };
  const result = entityType === 'song' ? await tx.song.updateMany({ where, data })
    : entityType === 'karaoke' ? await tx.karaoke.updateMany({ where, data })
    : entityType === 'playlist' ? await tx.playlist.updateMany({ where, data })
    : entityType === 'karaoke_playlist' ? await tx.karaokePlaylist.updateMany({ where, data })
    : await tx.customChord.updateMany({ where, data });
  const current = await findOwned(tx, entityType, existing.id, existing.userId);
  if (result.count !== 1) throw versionConflict(entityType, current);
  return current;
}

export function collectionVersion(userId: string, entityType: EntityType, entities: VersionedEntity[]): string {
  const versions = entities.map(entity => [entity.id, entity.version, entity.deletedAt?.toString() ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return `"${crypto.createHash('sha256').update(JSON.stringify([userId, entityType, versions])).digest('hex')}"`;
}

export function assertCollectionVersion(req: Request, userId: string, entityType: EntityType, entities: VersionedEntity[]) {
  const expected = collectionVersion(userId, entityType, entities);
  const supplied = req.get('X-Collection-Version');
  if (!supplied) throw new HttpError(428, 'Obtén la colección y envía X-Collection-Version antes de guardar', { code: 'collection_version_required' });
  if (supplied !== expected) {
    throw new HttpError(409, 'La colección ha cambiado; vuelve a cargarla antes de guardar', {
      code: 'collection_conflict', collectionVersion: expected
    });
  }
}
