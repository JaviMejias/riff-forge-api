const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

function resolveDatabaseUrl(value, projectRoot = root) {
  if (!value) return `file:${path.join(projectRoot, 'data/dev.db')}`;
  if (!value.startsWith('file:')) throw new Error('DATABASE_URL must be a SQLite file URL');
  const filename = value.slice(5);
  if (!filename || filename.includes('?') || filename === ':memory:') {
    throw new Error('DATABASE_URL must identify a SQLite file without query parameters');
  }
  return `file:${path.isAbsolute(filename) ? filename : path.resolve(projectRoot, 'prisma', filename)}`;
}

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;

module.exports = { databaseUrl, resolveDatabaseUrl };
