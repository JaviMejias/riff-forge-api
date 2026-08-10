"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncV2 = void 0;
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../utils/prisma");
const syncService_1 = require("../services/syncService");
const MAX_OPERATIONS = 100;
const MAX_PAGE_SIZE = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validOperation(value) {
    return value && uuid.test(value.operationId) && syncService_1.ENTITY_TYPES.includes(value.entityType) && uuid.test(value.entityId) &&
        ['upsert', 'delete'].includes(value.action) && Number.isInteger(value.baseVersion) && value.baseVersion >= 0 &&
        (value.data === undefined || (value.data && typeof value.data === 'object' && !Array.isArray(value.data)));
}
const syncV2 = async (req, res) => {
    const userId = req.userId;
    const { deviceId, operations = [] } = req.body || {};
    if (!uuid.test(deviceId || ''))
        return res.status(400).json({ error: 'invalid_device_id' });
    if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS)
        return res.status(400).json({ error: 'invalid_operations', maxOperations: MAX_OPERATIONS });
    let cursor;
    try {
        cursor = (0, syncService_1.decodeCursor)(req.body.cursor);
    }
    catch (_) {
        return res.status(400).json({ error: 'invalid_cursor' });
    }
    const requestedLimit = Number(req.query.limit || req.body.limit || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, MAX_PAGE_SIZE)) : 100;
    const rejectedOperations = [];
    const valid = operations.filter((operation) => {
        if (validOperation(operation))
            return true;
        rejectedOperations.push({ operationId: operation && operation.operationId || null, reason: 'validation_error', serverEntity: null });
        return false;
    });
    try {
        const acknowledgedOperationIds = await prisma_1.prisma.$transaction(async (tx) => {
            const acknowledged = [];
            for (const operation of valid) {
                const prior = await tx.processedSyncOperation.findUnique({ where: { userId_deviceId_operationId: { userId, deviceId, operationId: operation.operationId } } });
                if (prior) {
                    const result = JSON.parse(prior.result);
                    if (result.accepted)
                        acknowledged.push(operation.operationId);
                    else
                        rejectedOperations.push({ operationId: operation.operationId, ...result });
                    continue;
                }
                let result;
                try {
                    result = await (0, syncService_1.applyOperation)(tx, userId, operation);
                }
                catch (error) {
                    result = { accepted: false, reason: error.message === 'forbidden_reference' ? 'forbidden' : 'validation_error', serverEntity: null };
                }
                await tx.processedSyncOperation.create({ data: { userId, deviceId, operationId: operation.operationId, result: JSON.stringify(result), createdAt: BigInt(Date.now()) } });
                if (result.accepted)
                    acknowledged.push(operation.operationId);
                else
                    rejectedOperations.push({ operationId: operation.operationId, reason: result.reason, serverEntity: result.serverEntity });
            }
            return acknowledged;
        });
        const page = await (0, syncService_1.changesAfter)(prisma_1.prisma, userId, cursor, limit);
        return res.json({ acknowledgedOperationIds, rejectedOperations, changes: page.changes, nextCursor: (0, syncService_1.encodeCursor)(page.nextSequence), hasMore: page.hasMore });
    }
    catch (error) {
        console.error('Sync transaction failed', crypto_1.default.randomUUID(), error);
        return res.status(500).json({ error: 'sync_failed' });
    }
};
exports.syncV2 = syncV2;
