import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const rmFailWrapper = join(root, 'test', 'fixtures', 'rm-fail-wrapper.mjs');
const setupCli = join(root, 'bin', 'setup.cjs');

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

test('uninstall summary lists residuals instead of claiming completion (#1061 T2)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const dshHome = join(home, '.dsh');
    const pluginsDir = join(dshHome, 'huaweicloud-plugins');
    mkdirSync(join(pluginsDir, 'src'), { recursive: true });
    writeFileSync(join(pluginsDir, 'src', 'mcp-server.mjs'), 'x');

    const res = runCliWithRmFailure(home, ['uninstall', '--target', 'dsh'], pluginsDir, 'EBUSY', dshHome);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Uninstall finished with residuals/);
    assert.match(res.stdout, /^  - .*huaweicloud-plugins$/m, 'residual path listed in summary');
    assert.match(res.stdout, /Close the corresponding agent/);
    assert.match(res.stdout, /residual paths listed above/);
    assert.doesNotMatch(res.stdout, /Uninstall complete\./, 'must not claim completion with residuals');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('uninstall summary stays "Uninstall complete." when nothing survives (#1061 T2)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const dshHome = join(home, '.dsh');
    const pluginsDir = join(dshHome, 'huaweicloud-plugins');
    mkdirSync(join(pluginsDir, 'src'), { recursive: true });
    writeFileSync(join(pluginsDir, 'src', 'mcp-server.mjs'), 'x');
    mkdirSync(join(dshHome, 'skills', 'huawei-demo'), { recursive: true });

    const res = runCliWithRmFailure(home, ['uninstall', '--target', 'dsh'], '', 'EBUSY', dshHome);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Uninstall complete\./);
    assert.doesNotMatch(res.stdout, /Uninstall finished with residuals/);
    assert.doesNotMatch(res.stdout, /Residual left behind/);
    assert.ok(!existsSync(pluginsDir), 'plugin dir removed');
    assert.match(res.stdout, /本次仅卸载了 dsh 的插件/, 'existing follow-up hint unchanged');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('uninstall --target all also reports residuals honestly (#1061 T2)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const dshHome = join(home, '.dsh');
    const pluginsDir = join(dshHome, 'huaweicloud-plugins');
    mkdirSync(join(pluginsDir, 'src'), { recursive: true });
    writeFileSync(join(pluginsDir, 'src', 'mcp-server.mjs'), 'x');

    const res = runCliWithRmFailure(home, ['uninstall', '--target', 'all'], pluginsDir, 'EBUSY', dshHome);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Uninstall finished with residuals/);
    assert.match(res.stdout, /^  - .*huaweicloud-plugins$/m);
    assert.doesNotMatch(res.stdout, /Uninstall complete\./);
    assert.ok(existsSync(pluginsDir), 'locked plugin dir must remain on disk');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('install --target dsh prints conservative cleanup guidance on bundle skip (#1061 T3)', () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1061-home-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    const pluginsDir = join(dshHome, 'huaweicloud-plugins');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: huaweicloud-devkit',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: huaweicloud',
        '',
      ].join('\n'),
    );
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'leftover-file.txt'), 'user data');

    const res = spawnSync(process.execPath, [setupCli, 'install', '--target', 'dsh'], {
      cwd: home,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 600000,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installation complete!/);
    assert.match(res.stdout, /DSH patch already configured via bundle/);
    assert.match(res.stdout, /already configured; skipping/, 'references the DSH-side symptom');
    assert.match(res.stdout, /Close DSH sessions/);
    assert.match(res.stdout, /%USERPROFILE%\\\.dsh\\huaweicloud-plugins/);
    assert.match(res.stdout, /rmdir \/s \/q "%USERPROFILE%\\\.dsh\\huaweicloud-plugins"/);
    assert.match(res.stdout, /Remove-Item -Recurse -Force/);
    assert.match(res.stdout, /rm -rf ~\/\.dsh\/huaweicloud-plugins/);
    assert.match(res.stdout, /never deletes files automatically/, 'install promises no auto-deletion');
    assert.match(res.stdout, new RegExp(`Plugin directory: .*${dshHome.replaceAll('\\', '\\\\')}/huaweicloud-plugins`));
    assert.ok(existsSync(join(pluginsDir, 'leftover-file.txt')), 'install must not delete user files');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
