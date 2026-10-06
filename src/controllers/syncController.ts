import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { applyOperation, changesAfter, decodeCursor, encodeCursor, ENTITY_TYPES, SyncOperation } from '../services/syncService';
import { isRecord, isTimestamp } from '../services/inputValidation';
import { HttpError } from '../services/httpError';
import { recordRequestError } from '../middleware/requestDiagnostics';

const MAX_OPERATIONS = 100;
const MAX_PAGE_SIZE = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validOperation(value: unknown): value is SyncOperation {
  return isRecord(value) && typeof value.operationId === 'string' && uuid.test(value.operationId) &&
    typeof value.entityType === 'string' && ENTITY_TYPES.some(type => type === value.entityType) &&
    typeof value.entityId === 'string' && uuid.test(value.entityId) &&
    (value.action === 'upsert' || value.action === 'delete') &&
    typeof value.baseVersion === 'number' && Number.isInteger(value.baseVersion) && value.baseVersion >= 0 && value.baseVersion <= 2147483647 &&
    (value.clientUpdatedAt === undefined || (typeof value.clientUpdatedAt === 'number' && isTimestamp(value.clientUpdatedAt))) &&
    (value.data === undefined || isRecord(value.data));
}

export const syncV2 = async (req: Request, res: Response) => {
  const userId = req.userId!;
  if (!isRecord(req.body)) return res.status(400).json({ error: 'invalid_body' });
  const { deviceId, operations = [] } = req.body || {};
  if (typeof deviceId !== 'string' || !uuid.test(deviceId)) return res.status(400).json({ error: 'invalid_device_id' });
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) return res.status(400).json({ error: 'invalid_operations', maxOperations: MAX_OPERATIONS });
  let cursor: number;
  try { cursor = decodeCursor(req.body.cursor); } catch (_) { return res.status(400).json({ error: 'invalid_cursor' }); }
  const requestedLimit = Number(req.query.limit || req.body.limit || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, MAX_PAGE_SIZE)) : 100;
  const rejectedOperations: any[] = [];
  const valid = operations.filter((operation: any) => {
    if (validOperation(operation)) return true;
    rejectedOperations.push({ operationId: isRecord(operation) && typeof operation.operationId === 'string' ? operation.operationId : null, reason: 'validation_error', serverEntity: null });
    return false;
  });

  try {
    const acknowledgedOperationIds = await prisma.$transaction(async (tx: any) => {
      const acknowledged: string[] = [];
      for (const operation of valid) {
        const prior = await tx.processedSyncOperation.findUnique({ where: { userId_deviceId_operationId: { userId, deviceId, operationId: operation.operationId } } });
        if (prior) {
          const result = JSON.parse(prior.result);
          if (result.accepted) acknowledged.push(operation.operationId); else rejectedOperations.push({ operationId: operation.operationId, ...result });
          continue;
        }
        let result: any;
        try { result = await applyOperation(tx, userId, operation); }
        catch (error: unknown) {
          const expected = error instanceof HttpError && error.status === 400;
          const reason = error instanceof Error ? error.message : '';
          if (!expected && reason !== 'validation_error' && reason !== 'forbidden_reference') throw error;
          result = { accepted: false, reason: reason === 'forbidden_reference' ? 'forbidden' : 'validation_error', serverEntity: null };
        }
        await tx.processedSyncOperation.create({ data: { userId, deviceId, operationId: operation.operationId, result: JSON.stringify(result), createdAt: BigInt(Date.now()) } });
        if (result.accepted) acknowledged.push(operation.operationId); else rejectedOperations.push({ operationId: operation.operationId, reason: result.reason, serverEntity: result.serverEntity });
      }
      return acknowledged;
    });
    const page = await changesAfter(prisma, userId, cursor, limit);
    return res.json({ acknowledgedOperationIds, rejectedOperations, changes: page.changes, nextCursor: encodeCursor(page.nextSequence), hasMore: page.hasMore });
  } catch (error) {
    recordRequestError(res, error);
    return res.status(500).json({ error: 'sync_failed' });
  }
};
