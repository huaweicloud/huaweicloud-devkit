import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// CLI-level integration coverage for issue #615: user-customized MCP config
// fields (extra args, timeout) must survive update, uninstall, and reinstall
// through the real installer (bin/setup.cjs), not just the pure helpers.

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

const ENDPOINT_ARGS = [
  '--hdkitservice-endpoint',
  'http://devkit.topxtopx.com/rest/developer/server/hdkitservice/',
  '--telemetry-endpoint',
  'http://telemetry.example/collect',
];

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'devkit-mcp-cli-'));
}

function makeEnv(home) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    // Fail the installer's own update check instantly against a closed port
    // (installRuntimeDeps still uses the real npm registry, like agent-install).
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9',
  };
  // Clear agent home overrides so installs land in the temp home, not the real one.
  for (const key of ['ATOMCODE_HOME', 'DSH_HOME', 'HUAWEICLOUD_HOME', 'OFFICE_CLAW_CONFIG_ROOT']) {
    delete env[key];
  }
  return env;
}

function run(target, home, cmd, era) {
  const args = [setupCli, cmd, '--target', target];
  if (era) args.push('--opencode-mcp-era', era);
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 120000,
  });
}

function seedInstalled(home, { stalePath = false } = {}) {
  const srcDir = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'mcp-server.mjs'), '// seeded\n');
  const mcpPath = join(srcDir, 'mcp-server.mjs').replace(/\\/g, '/');
  const commandPath = stalePath ? '/home/stale-install/src/mcp-server.mjs' : mcpPath;
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify(
      {
        mcp: {
          'huaweicloud-devkit': {
            type: 'local',
            command: ['node', commandPath, ...ENDPOINT_ARGS],
            enabled: true,
            timeout: 600000,
          },
        },
      },
      null,
      2,
    ),
  );
  return mcpPath;
}

function readMcpEntry(home) {
  return JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp['huaweicloud-devkit'];
}

function readMcpV2Entry(home) {
  return JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp.servers[
    'huaweicloud-devkit'
  ];
}

function seedInstalledV2(home) {
  const srcDir = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'mcp-server.mjs'), '// seeded\n');
  const mcpPath = join(srcDir, 'mcp-server.mjs').replace(/\\/g, '/');
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify(
      {
        mcp: {
          servers: {
            'huaweicloud-devkit': { type: 'local', command: ['node', mcpPath, ...ENDPOINT_ARGS] },
          },
        },
      },
      null,
      2,
    ),
  );
  return mcpPath;
}

function backupFile(home) {
  return join(home, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
}

test('CLI update merges drifted entry: corrects path, keeps user args and timeout', () => {
  const home = makeHome();
  const mcpPath = seedInstalled(home, { stalePath: true });
  const res = run('opencode', home, 'update', 'v1');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /merged/);
  const entry = readMcpEntry(home);
  assert.deepEqual(entry.command, ['node', mcpPath, ...ENDPOINT_ARGS]);
  assert.equal(entry.timeout, 600000);
});

test('CLI uninstall backs up user delta and cleans the config entry', () => {
  const home = makeHome();
  seedInstalled(home);
  const res = run('opencode', home, 'uninstall');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.mcp?.['huaweicloud-devkit'], undefined);
  const backup = JSON.parse(readFileSync(backupFile(home), 'utf8'));
  assert.deepEqual(backup.opencode.commandExtra, ENDPOINT_ARGS);
  assert.equal(backup.opencode.timeout, 600000);
});

test('CLI install restores backed-up user fields and consumes the backup', () => {
  const home = makeHome();
  seedInstalled(home);
  assert.equal(run('opencode', home, 'uninstall').status, 0);
  assert.ok(existsSync(backupFile(home)));
  const res = run('opencode', home, 'install', 'v1');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const mcpPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const entry = readMcpEntry(home);
  assert.deepEqual(entry.command, ['node', mcpPath, ...ENDPOINT_ARGS]);
  assert.equal(entry.timeout, 600000);
  assert.equal(existsSync(backupFile(home)), false);
});

test('CLI install (v2) writes native mcp.servers entry without enabled/timeout', () => {
  const home = makeHome();
  const res = run('opencode', home, 'install', 'v2');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const entry = readMcpV2Entry(home);
  assert.ok(entry, 'entry written under mcp.servers');
  assert.equal(entry.type, 'local');
  assert.equal(entry.command[0], 'node');
  assert.match(entry.command[1], /huaweicloud-plugins[\\/]src[\\/]mcp-server\.mjs$/);
  assert.equal(entry.enabled, undefined, 'no flat enabled in v2');
  assert.equal(entry.timeout, undefined, 'no flat timeout in v2');
});

test('CLI update (v2) migrates a flat V1 entry into mcp.servers, preserving extra args', () => {
  const home = makeHome();
  seedInstalled(home);
  const res = run('opencode', home, 'update', 'v2');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.mcp['huaweicloud-devkit'], undefined, 'legacy flat form removed');
  const entry = config.mcp.servers['huaweicloud-devkit'];
  assert.ok(entry, 'entry migrated to mcp.servers');
  assert.deepEqual(entry.command.slice(2), ENDPOINT_ARGS, 'extra args survive the era switch');
  assert.equal(entry.enabled, undefined);
  assert.equal(entry.timeout, undefined);
});

test('CLI uninstall (v2) cleans the mcp.servers entry and backs up delta', () => {
  const home = makeHome();
  seedInstalledV2(home);
  const res = run('opencode', home, 'uninstall');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.mcp?.servers?.['huaweicloud-devkit'], undefined);
  const backup = JSON.parse(readFileSync(backupFile(home), 'utf8'));
  assert.deepEqual(backup.opencode.commandExtra, ENDPOINT_ARGS);
});

test('CLI install (v2) restores backed-up fields into the native form', () => {
  const home = makeHome();
  seedInstalledV2(home);
  assert.equal(run('opencode', home, 'uninstall').status, 0);
  assert.ok(existsSync(backupFile(home)));
  const res = run('opencode', home, 'install', 'v2');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const entry = readMcpV2Entry(home);
  assert.deepEqual(entry.command.slice(2), ENDPOINT_ARGS, 'extra args restored');
  assert.equal(existsSync(backupFile(home)), false);
});
