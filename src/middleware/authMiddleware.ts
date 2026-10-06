import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from '../services/httpError';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var is required but not set');

export function authenticatedUserId(authHeader: string | undefined): string | undefined {
  if (authHeader === undefined) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authHeader);
  if (!match) throw new HttpError(401, 'Sesión inválida');
  try {
    const decoded = jwt.verify(match[1], JWT_SECRET!, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || typeof decoded.userId !== 'string' || !decoded.userId) throw new Error('Invalid claims');
    return decoded.userId;
  } catch {
    throw new HttpError(401, 'Sesión inválida');
  }
}

export const authenticate = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const userId = authenticatedUserId(req.headers.authorization);
    if (!userId) throw new HttpError(401, 'Inicia sesión para continuar');
    req.userId = userId;
    next();
  } catch (error) { next(error); }
};
