const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-forge-build-'));
const buildDir = path.join(testDir, 'build');
const env = {
  ...process.env,
  RIFF_TEST_BUILD_DIR: buildDir,
  DATABASE_URL: `file:${path.join(testDir, 'generate-only.db')}`,
  NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
};

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? result.signal}`);
}

try {
  fs.cpSync(path.join(root, 'config'), path.join(testDir, 'config'), { recursive: true });
  run([path.join(root, 'scripts/prisma.js'), 'generate']);
  run([require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.json', '--outDir', buildDir]);
  const tests = fs.readdirSync(__dirname).filter(filename => filename.endsWith('.test.js')).sort();
  if (!tests.length) throw new Error('No test files found');
  run(['--test', ...tests.map(filename => path.join(__dirname, filename))]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
