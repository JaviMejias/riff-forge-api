const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
const lines = workflow.split('\n');
const migration = lines.find(line => line.includes('docker compose run') && line.includes('db:migrate'))?.trim();
const restart = lines.find(line => line.includes('docker compose up'))?.trim();

test('migration container cannot consume SSH script stdin and skip restarting the backend', { skip: process.platform === 'win32' }, () => {
  assert.ok(migration && restart);
  const result = spawnSync('bash', ['-se'], {
    encoding: 'utf8',
    input: `sudo() {
      case "$*" in
        *"compose run"*) cat > /dev/null; printf 'migration completed\\n' ;;
        *"compose up"*) printf 'backend restarted\\n' ;;
      esac
    }
    ${migration}
    ${restart}
    `
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration completed\nbackend restarted/);
});

test('a failed migration still prevents restarting the backend', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', ['-se'], {
    encoding: 'utf8',
    input: `sudo() {
      case "$*" in
        *"compose run"*) return 1 ;;
        *"compose up"*) printf 'backend restarted\\n' ;;
      esac
    }
    ${migration}
    ${restart}
    `
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /backend restarted/);
});
