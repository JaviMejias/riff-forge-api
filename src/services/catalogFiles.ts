import fs from 'fs';
import path from 'path';
import { catalogDataDir } from '../utils/storage';

const formats = new Set(['gp', 'gp3', 'gp4', 'gp5', 'gpx']);

function within(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function resolveCatalogFile(filePath: unknown, format: unknown): Promise<string | null> {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || filePath.includes('\0')) return null;
  if (typeof format !== 'string' || !formats.has(format.toLowerCase())) return null;
  if (path.posix.isAbsolute(filePath) || path.win32.parse(filePath).root) return null;
  const relativePath = filePath.replaceAll('\\', '/');
  if (relativePath.split('/').some(segment => !segment || segment.startsWith('.'))) return null;
  if (path.posix.extname(relativePath).toLowerCase() !== '.' + format.toLowerCase()) return null;
  const filename = path.resolve(catalogDataDir, relativePath);
  if (!within(catalogDataDir, filename)) return null;
  try {
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile()) return null;
    const [root, realFile] = await Promise.all([
      fs.promises.realpath(catalogDataDir), fs.promises.realpath(filename)
    ]);
    return within(root, realFile) ? realFile : null;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw error;
  }
}

export function catalogDownloadName(artist: string, title: string, format: string) {
  const label = `${artist} - ${title}`.replace(/[\\/\u0000-\u001f\u007f-\u009f]/g, '_').trim();
  const bounded = Array.from(label).slice(0, 120).map(character => /^[\ud800-\udfff]$/.test(character) ? '_' : character).join('');
  return `${bounded || 'tablatura'}.${format.toLowerCase()}`;
}
