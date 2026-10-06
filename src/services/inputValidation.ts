import { HttpError } from './httpError';
import { parsePitchShift } from './audioService';
import { normalizeChordArrays } from './chordData';

type MetadataType = 'song' | 'karaoke' | 'custom_chord' | 'playlist' | 'karaoke_playlist';
const MAX_TIMESTAMP = 8640000000000000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function invalidInput(field: string): never {
  throw new HttpError(400, `Campo inválido: ${field}`, { code: 'validation_error', field });
}

export function isTimestamp(value: unknown): boolean {
  const parsed = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_TIMESTAMP;
}

export function validateMetadata(type: MetadataType, value: unknown, creating = false, allowFormValues = false): void {
  if (!isRecord(value)) invalidInput('body');
  const present = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  if (creating || present('name')) {
    if (typeof value.name !== 'string' || !value.name.trim()) invalidInput('name');
  }

  const textFields = type === 'song'
    ? ['artist', 'album', 'textContent', 'originalKey', 'tuning', 'strummingPattern', 'capo']
    : type === 'karaoke' ? ['artist', 'youtubeUrl', 'textContent'] : [];
  for (const field of textFields) {
    if (present(field) && value[field] !== null && typeof value[field] !== 'string') invalidInput(field);
  }
  if (type === 'song' && present('type') && value.type !== null && value.type !== 'gp' && value.type !== 'text') invalidInput('type');
  if ((type === 'song' || type === 'karaoke') && present('dateAdded') && !isTimestamp(value.dateAdded)) invalidInput('dateAdded');

  if (type === 'custom_chord') {
    if ((creating || present('root')) && (typeof value.root !== 'string' || !value.root.trim())) invalidInput('root');
    if (creating && !present('frets')) invalidInput('frets');
    if (creating && !present('fingers')) invalidInput('fingers');
    normalizeChordArrays(value);
    if (creating || present('baseFret')) {
      const parsed = typeof value.baseFret === 'string' && /^(?:0|[1-9]\d*)$/.test(value.baseFret) ? Number(value.baseFret) : value.baseFret;
      if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > 2147483647) invalidInput('baseFret');
    }
  }

  for (const field of type === 'karaoke' ? ['isPublic', 'hasLocalAudio'] : ['isPublic']) {
    if (!present(field)) continue;
    const valid = typeof value[field] === 'boolean' || (allowFormValues && (value[field] === 'true' || value[field] === 'false'));
    if (!valid) invalidInput(field);
  }
  if (type === 'karaoke' && present('pitchShift')) {
    if (value.pitchShift === null || (allowFormValues && value.pitchShift === '')) return;
    try { parsePitchShift(value.pitchShift); } catch { invalidInput('pitchShift'); }
  }
}
