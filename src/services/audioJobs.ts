import { HttpError } from './httpError';

const activeUsers = new Set<string>();
const maxConcurrentJobs = 2;
const retryAfterSeconds = 5;

export async function runAudioJob<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (activeUsers.has(userId)) {
    throw new HttpError(429, 'Ya tienes un trabajo de audio en curso. Inténtalo de nuevo en unos segundos.', {
      code: 'audio_job_limit', retryAfterSeconds
    });
  }
  if (activeUsers.size >= maxConcurrentJobs) {
    throw new HttpError(503, 'El procesamiento de audio está ocupado. Inténtalo de nuevo en unos segundos.', {
      code: 'audio_capacity_exceeded', retryAfterSeconds
    });
  }
  // Reserve synchronously before starting work; never queue unbounded pending tasks.
  activeUsers.add(userId);
  try {
    return await work();
  } finally {
    activeUsers.delete(userId);
  }
}
