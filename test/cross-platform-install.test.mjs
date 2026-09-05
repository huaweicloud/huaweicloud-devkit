import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

function makeEnv(home) {
  return { ...process.env, USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) };
}

function runCli(home, cwd, args) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('install creates opencode config with normalized forward-slash paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-platform-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const config = readJson(join(home, '.config', 'opencode', 'opencode.json'));
    const cmd = config.mcp['huaweicloud-devkit'].command;
    assert.ok(cmd[1].includes('mcp-server.mjs'));
    assert.doesNotMatch(cmd[1], /\\/, 'MCP path must not contain backslashes');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install creates correct dir structure under homedir', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-platform-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'safety', 'policy.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install works with home dir containing spaces', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp platform spaces'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'src', 'mcp-server.mjs')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('handles platform-specific home directory resolution', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-userprofile-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const isWin = process.platform === 'win32';
    const env = {
      ...process.env,
      USERPROFILE: isWin ? home : join(tmpdir(), 'not-used'),
      HOME: isWin ? join(tmpdir(), 'not-used') : home,
    };
    const res = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'skills')), 'skills created under correct home');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install-hcloud shows platform-specific download instructions', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-hcloud-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['install-hcloud']);
    assert.equal(res.status, 0, res.stderr);
    const isWin = process.platform === 'win32';
    if (isWin) {
      assert.match(res.stdout, /huaweicloud-cli-windows-amd64\.zip/);
    } else {
      assert.match(res.stdout, /huaweicloud-cli-linux-(amd64|arm64)\.tar\.gz/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP server path is normalized to forward slashes', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-mcp-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    runCli(home, cwd, ['install', '--target', 'opencode']);
    const cfg = readJson(join(home, '.config', 'opencode', 'opencode.json'));
    const serverPath = cfg.mcp['huaweicloud-devkit'].command[1];
    assert.match(serverPath, /mcp-server\.mjs$/);
    assert.doesNotMatch(serverPath, /\\/, 'paths must use forward slashes');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall cleans up all platform directories', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-uninst-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(runCli(home, cwd, ['uninstall', '--target', 'opencode']).status, 0);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('version reports installed plugin version per agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-verinst-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, cwd, ['version']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OpenCode: \d+\.\d+\.\d+/);
    assert.doesNotMatch(res.stdout, /not installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('single-agent uninstall hints about global cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-uninst-hint-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, cwd, ['uninstall', '--target', 'opencode']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /如需清理全局配置/);
    assert.match(res.stdout, /uninstall --target all/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall --target all (non-TTY) keeps KooCLI/OBS but removes the vault', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-uninst-all-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);

    // Simulate account-level artifacts that `auth init` would have written.
    const vault = join(home, '.config', 'huaweicloud', 'credentials.json');
    mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(vault, '{}');
    const obsFile = join(home, '.obsutilconfig');
    writeFileSync(obsFile, 'ak=x\nsk=y\n');
    const kocliBin = join(home, '.local', 'bin', 'hcloud');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(kocliBin, '#!/bin/sh\n');

    const res = runCli(home, cwd, ['uninstall', '--target', 'all']);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(!existsSync(vault), 'vault should be removed on --target all');
    assert.ok(existsSync(obsFile), 'OBS config must be kept without a flag in non-TTY');
    assert.ok(existsSync(kocliBin), 'KooCLI must be kept without a flag in non-TTY');
    assert.match(res.stdout, /已保留 KooCLI 与 OBS 配置/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('auth reconcile dispatches to cmdAuthReconcile (no inconsistencies in clean home)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-reconcile-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['auth', 'reconcile']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /All credential files are consistent/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall --target all --clean-global removes KooCLI and OBS config', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-uninst-clean-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);

    const vault = join(home, '.config', 'huaweicloud', 'credentials.json');
    mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(vault, '{}');
    const obsFile = join(home, '.obsutilconfig');
    writeFileSync(obsFile, 'ak=x\nsk=y\n');
    const kocliBin = join(home, '.local', 'bin', 'hcloud');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(kocliBin, '#!/bin/sh\n');

    const res = runCli(home, cwd, ['uninstall', '--target', 'all', '--clean-global']);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(!existsSync(vault), 'vault should be removed on --target all');
    assert.ok(!existsSync(obsFile), 'OBS config should be removed with --clean-global');
    assert.ok(!existsSync(kocliBin), 'KooCLI should be removed with --clean-global');
    assert.match(res.stdout, /KooCLI removed/);
    assert.match(res.stdout, /OBS config removed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
