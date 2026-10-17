import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Install-time pack selection (--packs) through the real installer
// (bin/setup.cjs): the flag must land DEVKIT_PACKS in the OpenCode MCP config
// env layer, --packs all must remove it, bogus ids must fail before any file
// is copied, and user-set values must win.

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

function makeEnv(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    // Fail the installer's own update check instantly against a closed port.
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9',
  };
  // Clear agent home overrides so installs land in the temp home, not the real one.
  // XDG_CONFIG_HOME redirects the opencode config root (xdgConfigHome);
  // CODEX_HOME keys the uninstaller's codex cache cleanup.
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HUAWEICLOUD_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'DEVKIT_PACKS',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd: root,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function opencodeConfigPath(home: string) {
  return join(home, '.config', 'opencode', 'opencode.json');
}

function readEntry(home: string) {
  return JSON.parse(readFileSync(opencodeConfigPath(home), 'utf8')).mcp['huaweicloud-devkit'];
}

// Seed a drifted install (mcp-server.mjs era) whose entry carries a
// user-set DEVKIT_PACKS, so the install merge path runs against it.
function seedUserPacks(home: string, value: string) {
  const configDir = join(home, '.config', 'opencode');
  const srcDir = join(configDir, 'huaweicloud-plugins', 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'mcp-server.mjs'), '// seeded\n');
  const mcpPath = join(srcDir, 'mcp-server.mjs').replace(/\\/g, '/');
  writeFileSync(
    opencodeConfigPath(home),
    JSON.stringify(
      {
        mcp: {
          'huaweicloud-devkit': {
            type: 'local',
            command: ['node', mcpPath],
            enabled: true,
            environment: { DEVKIT_PACKS: value },
          },
        },
      },
      null,
      2,
    ),
  );
}

test('--packs sandbox writes DEVKIT_PACKS into the opencode MCP config env', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-write-'));
  try {
    const res = runCli(home, ['install', '--target', 'opencode', '--packs', 'sandbox']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const entry = readEntry(home);
    assert.equal(entry.environment?.DEVKIT_PACKS, 'sandbox', 'env layer must carry DEVKIT_PACKS=sandbox');
    assert.equal(entry.type, 'local');
    assert.equal(entry.command[0], 'node');
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--packs splits, trims, and normalizes a comma-separated id list', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-list-'));
  try {
    const res = runCli(home, ['install', '--target', 'opencode', '--packs', ' sandbox , auth ']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(readEntry(home).environment?.DEVKIT_PACKS, 'sandbox,auth');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--packs all removes the DEVKIT_PACKS key and restores full enablement', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-all-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'sandbox']).status, 0);
    assert.equal(readEntry(home).environment?.DEVKIT_PACKS, 'sandbox');

    const res = runCli(home, ['install', '--target', 'opencode', '--packs', 'all']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const entry = readEntry(home);
    assert.equal(entry.environment?.DEVKIT_PACKS, undefined, '--packs all must remove the key');
    assert.equal(entry.command[0], 'node', 'entry itself must stay intact');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bogus --packs fails non-zero before installing anything', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-bogus-'));
  try {
    const res = runCli(home, ['install', '--target', 'opencode', '--packs', 'bogus']);
    assert.notEqual(res.status, 0, 'bogus pack id must exit non-zero');
    assert.match(res.stderr, /bogus/, 'the unknown id must be named');
    assert.match(res.stderr, /Valid pack ids: .*\bsandbox\b/, 'the valid id list must be printed');
    assert.ok(!existsSync(opencodeConfigPath(home)), 'no config may be written on a bogus flag');
    assert.ok(
      !existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')),
      'no files may be copied on a bogus flag',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('without --packs the install writes no DEVKIT_PACKS key', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-noflag-'));
  try {
    const res = runCli(home, ['install', '--target', 'opencode']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const entry = readEntry(home);
    assert.equal(entry.environment, undefined, 'no environment field may appear without the flag');
    assert.equal(entry.env, undefined, 'no env field may appear without the flag');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a user-set DEVKIT_PACKS value wins over --packs with a warning', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-user-'));
  try {
    seedUserPacks(home, 'obs');
    const res = runCli(home, ['install', '--target', 'opencode', '--packs', 'sandbox']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const entry = readEntry(home);
    assert.equal(entry.environment?.DEVKIT_PACKS, 'obs', 'the user value must be kept');
    assert.match(
      res.stdout,
      /config already sets DEVKIT_PACKS="obs".*keeping it/,
      'the keep decision must be warned about',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--packs all clears even a user-set DEVKIT_PACKS value', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-userall-'));
  try {
    seedUserPacks(home, 'obs');
    const res = runCli(home, ['install', '--target', 'opencode', '--packs', 'all']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(readEntry(home).environment?.DEVKIT_PACKS, undefined, '--packs all is the reset hatch');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('update applies the same --packs policy idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-update-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'sandbox']).status, 0);
    const first = runCli(home, ['update', '--target', 'opencode', '--packs', 'sandbox']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(readEntry(home).environment?.DEVKIT_PACKS, 'sandbox');

    // A second update with the same value must not churn the config.
    const second = runCli(home, ['update', '--target', 'opencode', '--packs', 'sandbox']);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /OpenCode MCP config unchanged/);
    assert.equal(readEntry(home).environment?.DEVKIT_PACKS, 'sandbox');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
