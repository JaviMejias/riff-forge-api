import { HttpError } from './httpError';

type VectorField = 'frets' | 'fingers';
interface ChordArrays {
  frets?: unknown;
  fingers?: unknown;
  barres?: unknown;
}
interface Barre {
  fret: number;
  fromString: number;
  toString: number;
}
interface NormalizedChordArrays {
  frets?: string;
  fingers?: string;
  barres?: string | null;
}
const STRING_COUNT = 6;
const MAX_FRET = 2147483647;

function invalid(field: string): never {
  throw new HttpError(400, `Campo inválido: ${field}`, { code: 'validation_error', field });
}

function decode(value: unknown, field: string, allowCsv = false): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  try {
    const parsed = JSON.parse(text);
    if (!allowCsv || Array.isArray(parsed)) return parsed;
  } catch {}
  if (allowCsv && /^-?\d+(?:\s*,\s*-?\d+)*$/.test(text)) return text.split(',').map(item => Number(item.trim()));
  return invalid(field);
}

function vector(value: unknown, field: VectorField): number[] {
  const items = decode(value, field, true);
  if (!Array.isArray(items) || items.length > STRING_COUNT) invalid(field);
  const minimum = field === 'frets' ? -1 : 0;
  const maximum = field === 'frets' ? MAX_FRET : 5;
  for (const item of items) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum || item > maximum) invalid(field);
  }
  return items;
}

function barres(value: unknown): Array<number | Barre> | null {
  const items = decode(value, 'barres');
  if (items === null) return null;
  if (!Array.isArray(items) || items.length > STRING_COUNT) invalid('barres');
  return Array.from(items, item => {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= MAX_FRET) return item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('barres');
    const { fret, fromString, toString } = item;
    if (!Number.isInteger(fret) || fret < 1 || fret > MAX_FRET ||
      !Number.isInteger(fromString) || fromString < 1 || fromString > STRING_COUNT ||
      !Number.isInteger(toString) || toString < 1 || toString > STRING_COUNT || fromString === toString) invalid('barres');
    return { fret, fromString, toString };
  });
}

export function normalizeChordArrays(input: ChordArrays, existing: ChordArrays = {}): NormalizedChordArrays {
  const present = (key: keyof ChordArrays) => Object.prototype.hasOwnProperty.call(input, key);
  const merged = { ...existing, ...input };
  const frets = present('frets') || merged.frets !== undefined ? vector(merged.frets, 'frets') : undefined;
  const fingers = present('fingers') || merged.fingers !== undefined ? vector(merged.fingers, 'fingers') : undefined;
  const barreValues = present('barres') || merged.barres !== undefined ? barres(merged.barres) : undefined;
  if (frets && fingers?.length && fingers.length !== frets.length) invalid('fingers');
  if (frets && barreValues?.some(item => typeof item === 'object' && (item.fromString > frets.length || item.toString > frets.length))) invalid('barres');

  const normalized: NormalizedChordArrays = {};
  const fretsJson = JSON.stringify(frets);
  const fingersJson = JSON.stringify(fingers);
  const barresJson = barreValues === null ? null : JSON.stringify(barreValues);
  if (present('frets') || (existing.frets !== undefined && existing.frets !== fretsJson)) normalized.frets = fretsJson;
  if (present('fingers') || (existing.fingers !== undefined && existing.fingers !== fingersJson)) normalized.fingers = fingersJson;
  if (present('barres') || (existing.barres !== undefined && existing.barres !== barresJson)) normalized.barres = barresJson;
  return normalized;
}
