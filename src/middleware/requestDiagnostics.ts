import { randomUUID } from 'crypto';
import { RequestHandler, Response } from 'express';
import { HttpError } from '../services/httpError';

type ErrorCategory = 'unclassified' | 'internal_error' | 'database_error' | 'http_error' | 'syntax_error' | 'type_error' | 'system_error';
type DiagnosticContext = { requestId: string; errorCategory: ErrorCategory; errorCode: string | null };
const contexts = new WeakMap<Response, DiagnosticContext>();
const scopes = ['/api/auth', '/api/songs', '/api/karaokes', '/api/library', '/api/youtube', '/api/community', '/api/catalog', '/api/sync', '/api', '/uploads', '/health'];
const systemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'SQLITE_BUSY']);

export function recordRequestError(res: Response, error: unknown) {
  const context = contexts.get(res);
  if (!context) return;
  context.errorCategory = 'internal_error';
  context.errorCode = null;
  try {
    if (error instanceof HttpError) context.errorCategory = 'http_error';
    else if (error instanceof SyntaxError) context.errorCategory = 'syntax_error';
    else if (error instanceof TypeError) context.errorCategory = 'type_error';
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string') {
      if (/^P\d{4}$/.test(code)) {
        context.errorCategory = 'database_error';
        context.errorCode = code;
      } else if (systemCodes.has(code)) {
        context.errorCategory = 'system_error';
        context.errorCode = code;
      }
    }
  } catch {
    // Diagnostics must not fail a request when an unusual error has throwing getters.
    context.errorCategory = 'internal_error';
    context.errorCode = null;
  }
}

export const requestDiagnostics: RequestHandler = (req, res, next) => {
  const context: DiagnosticContext = { requestId: randomUUID(), errorCategory: 'unclassified', errorCode: null };
  contexts.set(res, context);
  res.set('X-Request-ID', context.requestId);
  const started = process.hrtime.bigint();
  const scope = scopes.find(value => req.path === value || req.path.startsWith(value + '/')) ?? 'unmatched';
  let completed = false;

  function complete(aborted: boolean) {
    if (completed) return;
    completed = true;
    if (!aborted && res.statusCode < 500) return;
    // Only application-defined route templates are logged, never paths, queries or error text.
    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const record = {
      timestamp: new Date().toISOString(), level: 'error',
      event: aborted ? 'request_aborted' : 'request_failed',
      requestId: context.requestId, method: req.method, scope, route,
      status: aborted && !res.headersSent ? null : res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      errorCategory: context.errorCategory, errorCode: context.errorCode
    };
    try { console.error(JSON.stringify(record)); } catch {
      // A broken diagnostic sink must not change the HTTP outcome.
    }
  }

  res.once('finish', () => complete(false));
  res.once('close', () => { if (!res.writableFinished) complete(true); });
  next();
};
