import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

// Characterization pins for the targets whose install/update/uninstall
// lifecycle had no spawn-level coverage (workbuddy, openclaw, atomcode) and
// for the hermes update path. Each test drives the real CLI against a fake
// HOME the way a user would and asserts the observable end state: payload
// layout, MCP config registration, hook deployment, marker, and removal on
// uninstall. The install/update pair unification in setup-cli.ts must keep
// every one of these green without edits.

// One warm npm cache shared by the lifecycle tests: every install spawns
// installRuntimeDeps (npm install undici), and a cold per-fixture cache
// puts ~10 registry fetches on the suite's critical path (AGENTS.md
// documents 79s on a bad registry day). npm's cache is content-addressed;
// sharing it across fixtures is safe.
const sharedNpmCache = fixtureDir('tl-npm-cache-');

function makeEnv(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    HUAWEICLOUD_HOME: home,
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    npm_config_cache: sharedNpmCache,
  };
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete env[key];
  }
  delete env.HCLOUD_BIN;
  return env;
}

function runCli(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function assertPayloadInstalled(pluginDir: string): void {
  assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')), 'server bundle missing');
  assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')), 'safety policy missing');
  assert.ok(existsSync(join(pluginDir, 'skills', '.manifest.json')), 'skills manifest missing');
  assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker missing');
}

function assertMcpEntry(configPath: string, mapKey: 'mcpServers' | 'mcp'): void {
  const config = readJson(configPath);
  const entry = (config[mapKey] as Record<string, unknown> | undefined)?.['huaweicloud-devkit'];
  assert.ok(entry, `${configPath} has no huaweicloud-devkit entry`);
  const rendered = JSON.stringify(entry);
  assert.match(rendered, /dist\/mcp-server\.js/, `entry does not point at the server: ${rendered}`);
}

// The install-mode contract every lifecycle test opens with: the command
// succeeds under its target banner and leaves the payload triple in place.
function assertInstallSucceeded(target: string, label: string, home: string, cwd: string, pluginDir: string): void {
  const install = runCli(home, cwd, ['install', '--target', target]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, new RegExp(`\\[${label}\\]`));
  assertPayloadInstalled(pluginDir);
}

test('workbuddy lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('wb-home-');
  const cwd = fixtureDir('wb-proj-');
  const pluginDir = join(home, '.workbuddy', 'huaweicloud-plugins');
  const configPath = join(home, '.workbuddy', 'mcp.json');

  assertInstallSucceeded('workbuddy', 'WorkBuddy', home, cwd, pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const update = runCli(home, cwd, ['update', '--target', 'workbuddy']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'workbuddy']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  if (existsSync(configPath)) {
    const config = readJson(configPath);
    assert.equal(
      (config.mcpServers as Record<string, unknown> | undefined)?.['huaweicloud-devkit'],
      undefined,
      'mcp.json entry survived uninstall',
    );
  }
});

test('openclaw lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('oc-home-');
  const cwd = fixtureDir('oc-proj-');
  const pluginDir = join(home, '.agents', 'huaweicloud-plugins');
  const commandsDir = join(home, '.agents', 'commands');

  assertInstallSucceeded('openclaw', 'OpenClaw', home, cwd, pluginDir);
  assertMcpEntry(join(pluginDir, '.mcp.json'), 'mcpServers');
  assert.ok(existsSync(join(pluginDir, '.codex-plugin')), 'codex plugin manifest missing');
  const commands = existsSync(commandsDir) ? readdirSync(commandsDir) : [];
  assert.ok(commands.includes('huaweicloud-doctor.md'), `commands missing: ${commands.join(',')}`);

  const update = runCli(home, cwd, ['update', '--target', 'openclaw']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(join(pluginDir, '.mcp.json'), 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'openclaw']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  const remaining = existsSync(commandsDir) ? readdirSync(commandsDir) : [];
  assert.ok(
    !remaining.some((name) => name.startsWith('huawei')),
    `huawei* commands survived uninstall: ${remaining.join(',')}`,
  );
});

test('atomcode lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('ac-home-');
  const cwd = fixtureDir('ac-proj-');
  const atomcodeHome = join(home, '.atomcode');
  const pluginDir = join(atomcodeHome, 'huaweicloud-plugins');
  const configPath = join(atomcodeHome, 'mcp.json');
  const hooksConfigPath = join(atomcodeHome, 'hooks.json');

  assertInstallSucceeded('atomcode', 'AtomCode', home, cwd, pluginDir);
  assertMcpEntry(configPath, 'mcpServers');
  assert.ok(existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.js')), 'telemetry hook script missing');
  const hooks = readJson(hooksConfigPath);
  const hwTelemetry = (hooks.hooks as Record<string, unknown> | undefined)?.['hw-telemetry'];
  assert.equal((hwTelemetry as Record<string, unknown> | undefined)?.event, 'pre_tool_use');
  assert.equal(typeof (hwTelemetry as Record<string, unknown> | undefined)?.command, 'string');

  const update = runCli(home, cwd, ['update', '--target', 'atomcode']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'atomcode']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  if (existsSync(hooksConfigPath)) {
    const hooks = readJson(hooksConfigPath);
    assert.equal(
      (hooks.hooks as Record<string, unknown> | undefined)?.['hw-telemetry'],
      undefined,
      'hw-telemetry hook survived uninstall',
    );
  }
  if (existsSync(configPath)) {
    const config = readJson(configPath);
    assert.equal(
      (config.mcpServers as Record<string, unknown> | undefined)?.['huaweicloud-devkit'],
      undefined,
      'mcp.json entry survived uninstall',
    );
  }
});

test('codex-desktop install does not destroy an existing openclaw installation', () => {
  // The pre-marketplace-era cleanup in deployCodexDesktop removes
  // ~/.agents/huaweicloud-plugins — which is openclawPluginsDir(), OpenClaw's
  // LIVE install location. A codex-desktop install on a machine with OpenClaw
  // silently destroyed it; the cleanup now fires only when no server payload
  // lives there.
  const home = fixtureDir('cx-home-');
  const cwd = fixtureDir('cx-proj-');
  const openclawDir = join(home, '.agents', 'huaweicloud-plugins');

  // A live OpenClaw install: payload present.
  mkdirSync(join(openclawDir, 'dist'), { recursive: true });
  writeFileSync(join(openclawDir, 'dist', 'mcp-server.js'), '// live openclaw server');

  const res = runCli(home, cwd, ['install', '--target', 'codex-desktop']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(
    existsSync(join(openclawDir, 'dist', 'mcp-server.js')),
    'a live openclaw installation must survive a codex-desktop install',
  );

  // Residue (no server payload) is still cleaned: the pre-marketplace-era
  // behavior the block exists for.
  const residueHome = fixtureDir('cx-res-home-');
  const residueDir = join(residueHome, '.agents', 'huaweicloud-plugins');
  mkdirSync(residueDir, { recursive: true });
  writeFileSync(join(residueDir, 'stale-marker.txt'), 'pre-marketplace residue');
  const res2 = runCli(residueHome, cwd, ['install', '--target', 'codex-desktop']);
  assert.equal(res2.status, 0, res2.stderr);
  assert.ok(!existsSync(residueDir), 'pre-marketplace residue without a payload is still cleaned');
});

test('hermes --skip-mcp-server install ships no marker: nothing will run from that dir', () => {
  // The .installed marker means "a server payload was placed — restart to
  // activate". A clone-based skip-mcp install ships skills+safety but no
  // dist/, and no server ever runs from the plugin dir to consume the
  // marker (the running server deletes it at boot) — a marker there would
  // print doctor's restart banner forever for a legitimate flow.
  const home = fixtureDir('hm-skip-home-');
  const cwd = fixtureDir('hm-skip-proj-');
  const pluginDir = join(home, '.hermes', 'huaweicloud-plugins');

  const res = runCli(home, cwd, ['install', '--target', 'hermes', '--skip-mcp-server']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(pluginDir, 'skills', '.manifest.json')), 'skills still ship as server data');
  assert.ok(!existsSync(join(pluginDir, 'dist')), 'no server shipped');
  assert.ok(!existsSync(join(pluginDir, '.installed')), 'no payload placement, no restart marker');
});

test('hermes update refreshes payload, config, and hooks', () => {
  const home = fixtureDir('hm-home-');
  const cwd = fixtureDir('hm-proj-');
  const pluginDir = join(home, '.hermes', 'huaweicloud-plugins');
  const configPath = join(home, '.hermes', 'config.yaml');

  const install = runCli(home, cwd, ['install', '--target', 'hermes']);
  assert.equal(install.status, 0, install.stderr);

  const update = runCli(home, cwd, ['update', '--target', 'hermes']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  const config = readFileSync(configPath, 'utf8');
  assert.match(config, /huaweicloud-devkit/);
  assert.match(config, /mcp-server\.js/);
  assert.ok(existsSync(join(pluginDir, 'hooks', 'huaweicloud-safety.mjs')), 'safety hook missing');
  assert.ok(existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.py')), 'telemetry hook missing');
});

test('hermes lifecycle merges into and out of a user-owned mcp_servers config', () => {
  // A hermes config that already registers a user MCP server: the devkit
  // entry must merge under the existing mcp_servers mapping on install and
  // leave the user's server untouched on update and uninstall (the
  // duplicate-key writer corrupted exactly this shape).
  const home = fixtureDir('hm-merge-home-');
  const cwd = fixtureDir('hm-merge-proj-');
  const pluginDir = join(home, '.hermes', 'huaweicloud-plugins');
  const configPath = join(home, '.hermes', 'config.yaml');

  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(
    configPath,
    'model:\n  provider: "openrouter"\nmcp_servers:\n  filesystem:\n    command: "npx"\n    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n',
    'utf8',
  );

  const mcpKeyCount = (content: string): number => (content.match(/^mcp_servers:$/gm) || []).length;

  const install = runCli(home, cwd, ['install', '--target', 'hermes']);
  assert.equal(install.status, 0, install.stderr);
  assertPayloadInstalled(pluginDir);
  let config = readFileSync(configPath, 'utf8');
  assert.equal(mcpKeyCount(config), 1, 'install must not add a second mcp_servers key');
  assert.match(
    config,
    /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"$/m,
    'user server stays nested under mcp_servers',
  );
  assert.match(config, /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'devkit entry merges as a sibling child');

  const update = runCli(home, cwd, ['update', '--target', 'hermes']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  config = readFileSync(configPath, 'utf8');
  assert.equal(mcpKeyCount(config), 1, 'update must not add a second mcp_servers key');
  assert.match(config, /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"$/m, 'user server survives the update');
  assert.match(config, /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'devkit entry survives the update');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'hermes']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  config = readFileSync(configPath, 'utf8');
  assert.equal(mcpKeyCount(config), 1, 'uninstall must keep the user-owned mcp_servers key');
  assert.doesNotMatch(config, /huaweicloud-devkit/, 'devkit entry survived uninstall');
  assert.match(config, /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"$/m, 'user server survives the uninstall');

  // Reinstall after uninstall must not inherit the user server's args: the
  // #615 delta save is scoped to the devkit child's own args line.
  const reinstall = runCli(home, cwd, ['install', '--target', 'hermes']);
  assert.equal(reinstall.status, 0, reinstall.stderr);
  config = readFileSync(configPath, 'utf8');
  assert.equal(mcpKeyCount(config), 1, 'reinstall keeps a single mcp_servers key');
  assert.match(
    config,
    /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \["[^\]]*mcp-server\.js"\]$/m,
    'reinstalled devkit args carry only the server path',
  );
  assert.match(
    config,
    /^ {2}filesystem:\n {4}command: "npx"\n {4}args: \["-y", "@modelcontextprotocol\/server-filesystem", "\/tmp"\]$/m,
    'the user server is intact after reinstall',
  );
});
