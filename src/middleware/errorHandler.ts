import { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { HttpError } from '../services/httpError';
import { recordRequestError } from './requestDiagnostics';

function errorType(error: unknown): unknown {
  try { return error !== null && typeof error === 'object' && 'type' in error ? error.type : undefined; } catch { return undefined; }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  recordRequestError(res, error);
  if (res.headersSent) {
    // Express's default final handler prints raw error text; terminate the partial response without forwarding it.
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    const retryAfter = error.details?.retryAfterSeconds;
    if ((error.status === 429 || error.status === 503) && typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      res.set('Retry-After', String(retryAfter));
    }
    return res.status(error.status).json({ error: error.message, ...error.details });
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: 'Carga de archivo inválida', code: error.code });
  }
  const type = errorType(error);
  if (type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  res.status(500).json({ error: 'Internal Server Error' });
};
