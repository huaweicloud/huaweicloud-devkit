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

function run(target, home, cmd) {
  return spawnSync(process.execPath, [setupCli, cmd, '--target', target], {
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

function backupFile(home) {
  return join(home, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
}

test('CLI update merges drifted entry: corrects path, keeps user args and timeout', () => {
  const home = makeHome();
  seedInstalled(home, { stalePath: true });
  const res = run('opencode', home, 'update');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /merged/);
  const entry = readMcpEntry(home);
  const correctedPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js').replace(
    /\\/g,
    '/',
  );
  assert.deepEqual(entry.command, ['node', correctedPath, ...ENDPOINT_ARGS]);
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
  const res = run('opencode', home, 'install');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const mcpPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const entry = readMcpEntry(home);
  assert.deepEqual(entry.command, ['node', mcpPath, ...ENDPOINT_ARGS]);
  assert.equal(entry.timeout, 600000);
  assert.equal(existsSync(backupFile(home)), false);
});
