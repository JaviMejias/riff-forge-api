const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { databaseUrl } = require('../config/database');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args[0] === 'migrate' && args[1] === 'deploy') {
  fs.mkdirSync(path.dirname(databaseUrl.slice(5)), { recursive: true });
}
const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
