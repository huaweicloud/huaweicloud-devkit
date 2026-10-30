import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const rmFailWrapper = join(root, 'test', 'fixtures', 'rm-fail-wrapper.mjs');

function makeEnv(home, dshHome) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    DSH_HOME: dshHome,
    HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL: '1',
  };
}

function runCliWithRmFailure(home, args, failPath, failCode = 'EBUSY', dshHome = join(home, '.dsh')) {
  return spawnSync(process.execPath, ['--experimental-test-module-mocks', rmFailWrapper, ...args], {
    cwd: home,
    env: { ...makeEnv(home, dshHome), FORCE_RM_FAIL_PATH: failPath, FORCE_RM_FAIL_CODE: failCode },
    encoding: 'utf8',
    timeout: 600000,
  });
}

function assertRemovalGuidance(stdout, pathRe) {
  assert.match(stdout, new RegExp(`Residual left behind: .*${pathRe}`), 'residual path surfaced');
  assert.match(stdout, /Close the corresponding agent/, 'close-agent hint surfaced');
  assert.match(stdout, /file lock/, 'file-lock explanation surfaced');
  assert.match(stdout, new RegExp(`rmdir /s /q .*${pathRe}`), 'Windows cmd removal command surfaced');
  assert.match(
    stdout,
    new RegExp(`Remove-Item -Recurse -Force .*${pathRe}`),
    'Windows PowerShell removal command surfaced',
  );
  assert.match(stdout, new RegExp(`rm -rf .*${pathRe}`), 'POSIX removal command surfaced');
}

test('uninstall --target dsh prints file-lock guidance when a locked path survives (#1061 T1)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const dshHome = join(home, '.dsh');
    const pluginsDir = join(dshHome, 'huaweicloud-plugins');
    mkdirSync(join(pluginsDir, 'src'), { recursive: true });
    writeFileSync(join(pluginsDir, 'src', 'mcp-server.mjs'), 'x');
    mkdirSync(join(dshHome, 'skills', 'huawei-demo'), { recursive: true });

    const res = runCliWithRmFailure(home, ['uninstall', '--target', 'dsh'], pluginsDir, 'EBUSY', dshHome);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Could not remove .*huaweicloud-plugins: EBUSY/);
    assertRemovalGuidance(res.stdout, 'huaweicloud-plugins');
    assert.ok(existsSync(pluginsDir), 'locked plugin dir must remain on disk');
    assert.ok(!existsSync(join(dshHome, 'skills', 'huawei-demo')), 'unlocked skills still removed');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('uninstall --target opencode gets the same shared-mechanism guidance (#1061 T1)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const pluginsDir = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'marker.txt'), 'x');

    const res = runCliWithRmFailure(home, ['uninstall', '--target', 'opencode'], pluginsDir, 'EPERM');

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Could not remove .*huaweicloud-plugins: EPERM/);
    assertRemovalGuidance(res.stdout, 'huaweicloud-plugins');
    assert.ok(existsSync(pluginsDir), 'locked plugin dir must remain on disk');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
