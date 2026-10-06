import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import { isRecord, invalidInput } from '../services/inputValidation';
import { HttpError } from '../services/httpError';
import { recordRequestError } from '../middleware/requestDiagnostics';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var is required but not set');

function credentials(body: unknown) {
  if (!isRecord(body)) invalidInput('body');
  if (typeof body.email !== 'string' || !body.email.trim()) invalidInput('email');
  if (typeof body.password !== 'string' || !body.password) invalidInput('password');
  return { email: body.email, password: body.password };
}

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = credentials(req.body);
    const { name } = req.body;
    if (name !== undefined && name !== null && typeof name !== 'string') invalidInput('name');
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, name }
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    recordRequestError(res, error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = credentials(req.body);
    
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, uiStorage: user.uiStorage } });
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    recordRequestError(res, error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const verifyToken = async (req: Request, res: Response) => {
  const userId = req.userId;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    res.json({ user: { id: user.id, email: user.email, name: user.name, uiStorage: user.uiStorage } });
  } catch (error) {
    recordRequestError(res, error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const saveSettings = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.userId;
  try {
    if (!isRecord(req.body) || !isRecord(req.body.uiStorage)) invalidInput('uiStorage');
    const { uiStorage } = req.body;
    await prisma.user.update({
      where: { id: userId },
      data: { uiStorage: JSON.stringify(uiStorage) }
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    recordRequestError(res, error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
};
