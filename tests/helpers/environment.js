const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function createEnvironment(prefix) {
  const root = path.resolve(__dirname, '../..');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${path.join(testDir, 'test.db')}`;
  process.env.UPLOAD_DIR = path.join(testDir, 'uploads');
  process.env.JWT_SECRET = 'integration-test-secret-with-sufficient-length';
  execFileSync(process.execPath, [path.join(root, 'scripts/prisma.js'), 'migrate', 'deploy'], {
    cwd: root, env: process.env, stdio: 'pipe'
  });
  const buildDir = process.env.RIFF_TEST_BUILD_DIR || path.join(root, 'dist');
  return {
    testDir,
    load: name => require(path.join(buildDir, name)),
    cleanup: () => fs.rmSync(testDir, { recursive: true, force: true })
  };
}

module.exports = { createEnvironment };
