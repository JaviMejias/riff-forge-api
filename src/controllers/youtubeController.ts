import { Request, Response, NextFunction } from 'express';
import { downloadYouTubeAudio } from '../services/audioService';

export const extractAudio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = await downloadYouTubeAudio(req.userId, req.body?.url);
    res.json({ success: true, url });
  } catch (error) {
    next(error);
  }
};
