import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

function makeEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
    // `uninstall --target all` dispatches uninstallOfficeAce, which probes
    // the real Windows registry / Program Files without this skip (#654) —
    // on a dev machine with a real OfficeAce it would uninstall it.
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
  };
  // The installer honors XDG_CONFIG_HOME for opencode (xdgConfigHome) and
  // CODEX_HOME for the codex cache cleanup (uninstallCodex). This suite also
  // runs `uninstall --target all`, which dispatches every per-target
  // uninstall (hermes/dsh/atomcode/officeace) — each keyed on its own
  // ambient home override — so the full standard clear list applies.
  for (const key of [
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'HERMES_HOME',
    'DSH_HOME',
    'ATOMCODE_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(
  home: string,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: { ...makeEnv(home), ...extraEnv },
    encoding: 'utf8',
    // install commands are network-bound: every fake-HOME install fetches
    // undici from the npm registry into a cold cache ($HOME/.npm), which
    // measured 79s on a high-latency registry day — 60s killed the install
    // mid-flight (status null). Other commands return in seconds; the
    // timeout is only an upper bound for them.
    timeout: 240000,
  });
}

interface OpencodeConfig {
  mcp: Record<string, { command: string[] }>;
}

function readJson(path: string): OpencodeConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as OpencodeConfig;
}

test('install creates opencode config with normalized forward-slash paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-platform-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const config = readJson(join(home, '.config', 'opencode', 'opencode.json'));
    const cmd = config.mcp['huaweicloud-devkit'].command;
    assert.ok(cmd[1].includes('mcp-server.js'));
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
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
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
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('handles platform-specific home directory resolution', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-userprofile-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    // Ride makeEnv for the ambient-override hygiene (XDG_CONFIG_HOME etc.)
    // and keep the test's discrimination: the platform-discordant home var
    // points elsewhere so the resolver must pick the right one.
    const env = makeEnv(home);
    if (process.platform === 'win32') env.HOME = join(tmpdir(), 'not-used');
    else env.USERPROFILE = join(tmpdir(), 'not-used');
    const res = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
      cwd,
      env,
      encoding: 'utf8',
      // Install-bearing spawn: cold-cache undici fetch needs the 240s class
      // (see runCli above), not 60s.
      timeout: 240000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills')),
      'skills tree (server data) created under correct home',
    );
    // Core meta-skills are natively disclosed under the same home; every
    // non-core skill stays off the native surface (MCP catalog, plus the
    // stdio skillRoot location disclosure). The roster comes from the same
    // manifest parser the CLI reads.
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    assert.ok(existsSync(nativeDir), 'native skill dir created for core disclosure');
    const nativeOwned = readdirSync(nativeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei'))
      .map((d) => d.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const expectedCore = [
      ...(parseCoreSkillNames(
        readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8'),
      ) ?? new Set()),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(nativeOwned, expectedCore, 'native dir carries exactly the core meta-skills');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode install follows an absolute XDG_CONFIG_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-xdg-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const xdgRoot = join(home, 'xdg-config');
    const res = runCli(home, cwd, ['install', '--target', 'opencode'], { XDG_CONFIG_HOME: xdgRoot });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    // Everything lands under the XDG root opencode actually reads.
    assert.ok(existsSync(join(xdgRoot, 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(xdgRoot, 'opencode', 'skills')), 'native skills under the XDG root');
    const config = readJson(join(xdgRoot, 'opencode', 'opencode.json'));
    assert.ok(config.mcp['huaweicloud-devkit'], 'mcp entry written under the XDG root');
    // The legacy default root stays untouched.
    assert.ok(!existsSync(join(home, '.config', 'opencode')), 'legacy ~/.config/opencode must not be created');
    // status reads the same root (detection alignment).
    const status = runCli(home, cwd, ['status', '--target', 'opencode'], { XDG_CONFIG_HOME: xdgRoot });
    assert.equal(status.status, 0, `stderr: ${status.stderr}`);
    assert.match(status.stdout, /MCP Server:.*Installed/);
    // Uninstall cleans the XDG root side.
    assert.equal(runCli(home, cwd, ['uninstall', '--target', 'opencode'], { XDG_CONFIG_HOME: xdgRoot }).status, 0);
    assert.ok(!existsSync(join(xdgRoot, 'opencode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('relative XDG_CONFIG_HOME values are ignored (spec: absolute only)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-xdgrel-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    // The installer follows the XDG spec (absolute only). Known divergence:
    // the pinned opencode (1.19.0) honors relative values against its cwd,
    // so this input class still splits installer from agent — accepted
    // rather than matching cwd-dependent resolution (see xdgConfigHome).
    const res = runCli(home, cwd, ['install', '--target', 'opencode'], { XDG_CONFIG_HOME: 'relative-xdg' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(
      existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')),
      'falls back to the default ~/.config root',
    );
    assert.ok(!existsSync(join(cwd, 'relative-xdg')), 'no relative dir materialized');
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
    assert.match(serverPath, /mcp-server\.js$/);
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

test('version reports CLI version and installed plugin version per agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-verinst-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, cwd, ['version']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /HuaweiCloud DevKit CLI: \d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?/);
    assert.match(res.stdout, /Installed agent plugins:/);
    assert.match(res.stdout, /OpenCode: \d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?/);
    assert.match(res.stdout, /update --target <agent>/);
    assert.doesNotMatch(res.stdout, /No Huawei Cloud DevKit plugin installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('version reports CLI version and install hint when no agent plugin is installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-verempty-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  try {
    const res = runCli(home, cwd, ['version']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /HuaweiCloud DevKit CLI: \d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?/);
    assert.match(res.stdout, /No Huawei Cloud DevKit plugin installed/);
    assert.match(res.stdout, /install --target <agent>/);
    assert.doesNotMatch(res.stdout, /Installed agent plugins:/);
    assert.doesNotMatch(res.stdout, /update --target <agent>/);
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
    assert.match(res.stdout, /已保留 KooCLI、OBS 配置与 open-mcp-gateway/);
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
