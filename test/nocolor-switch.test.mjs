import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const SCRIPT_BIN = process.platform === 'linux' && existsSync('/usr/bin/script') ? '/usr/bin/script' : null;

// Byte-level detection of ANSI CSI escape sequences (ESC [), see no-color.org / #902.
const ESC_CSI = String.fromCharCode(27) + '[';
const hasAnsi = (s) => s.includes(ESC_CSI);

// Literal `${...}` leak: escaped template interpolation (e.g. `\${GRN}`) renders as
// literal text instead of the color constant, polluting output in every color mode.
const hasLiteralInterpolation = (s) => s.includes('${');

function makeEnv(home, extra = {}) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
    ...extra,
  };
}

// Runs the CLI in a temp home. Output is captured via pipes (non-TTY), matching
// the "redirected / piped" scenario from the acceptance criteria.
function runCli(home, extraEnv = {}) {
  return spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
    cwd: tmpdir(),
    env: makeEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nocolor-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('#902 NO_COLOR=1: stdout and stderr contain no ANSI escapes (non-TTY)', () => {
  withTempHome((home) => {
    const res = runCli(home, { NO_COLOR: '1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(!hasAnsi(res.stdout), 'stdout must not contain ANSI escapes under NO_COLOR');
    assert.ok(!hasAnsi(res.stderr), 'stderr must not contain ANSI escapes under NO_COLOR');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'stdout must not leak literal ${...} interpolation');
    assert.ok(!hasLiteralInterpolation(res.stderr), 'stderr must not leak literal ${...} interpolation');
  });
});

test('#902 NO_COLOR takes priority over FORCE_COLOR', () => {
  withTempHome((home) => {
    const res = runCli(home, { NO_COLOR: '1', FORCE_COLOR: '1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(!hasAnsi(res.stdout), 'NO_COLOR must win over FORCE_COLOR');
    assert.ok(!hasAnsi(res.stderr), 'NO_COLOR must win over FORCE_COLOR');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'stdout must not leak literal ${...} interpolation');
    assert.ok(!hasLiteralInterpolation(res.stderr), 'stderr must not leak literal ${...} interpolation');
  });
});

test('#902 non-TTY (piped) default run contains no ANSI escapes', () => {
  withTempHome((home) => {
    const res = runCli(home, { NO_COLOR: '', FORCE_COLOR: '' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(!hasAnsi(res.stdout), 'piped stdout must be de-colored automatically');
    assert.ok(!hasAnsi(res.stderr), 'piped stderr must be de-colored automatically');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'stdout must not leak literal ${...} interpolation');
    assert.ok(!hasLiteralInterpolation(res.stderr), 'stderr must not leak literal ${...} interpolation');
  });
});

test('#902 FORCE_COLOR=1 forces ANSI escapes back on (color path preserved)', () => {
  withTempHome((home) => {
    const res = runCli(home, { FORCE_COLOR: '1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(hasAnsi(res.stdout), 'FORCE_COLOR must re-enable colored output');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'colored stdout must not leak literal ${...} interpolation');
  });
});

test('#902 empty NO_COLOR does not disable colors when FORCE_COLOR is set', () => {
  withTempHome((home) => {
    const res = runCli(home, { NO_COLOR: '', FORCE_COLOR: '1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(hasAnsi(res.stdout), 'empty NO_COLOR must not disable coloring');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'stdout must not leak literal ${...} interpolation');
  });
});

test('#902 default TTY run still emits colors (pty via util-linux script)', { skip: !SCRIPT_BIN }, () => {
  withTempHome((home) => {
    const cmd = `"${process.execPath}" "${setupCli}" install --target opencode`;
    const res = spawnSync(SCRIPT_BIN, ['-qec', cmd, '/dev/null'], {
      cwd: tmpdir(),
      env: makeEnv(home, { NO_COLOR: '', FORCE_COLOR: '' }),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, `output: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.ok(hasAnsi(res.stdout), 'default TTY output must keep ANSI colors');
    assert.ok(!hasLiteralInterpolation(res.stdout), 'TTY stdout must not leak literal ${...} interpolation');
  });
});
