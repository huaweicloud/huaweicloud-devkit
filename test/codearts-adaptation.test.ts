import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Core meta-skill count from the shipped manifest — the same parser the
// CLI uses for the native disclosure.
const coreSkillCount = (
  parseCoreSkillNames(readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8')) ??
  new Set()
).size;

function makeEnv(home: string, _cwd: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
  };
  // cleanupNativeDirs() runs inside every install and reconciles EVERY
  // target's native dir (not just codearts), each resolved from its own
  // ambient override — clear the ones this file does not pin.
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
  delete env.HCLOUD_BIN;
  return env;
}

function runCli(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, cwd),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function countSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function mcpConfig(path: string) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('codearts install copies skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[CodeArts\]/);
    assert.match(res.stdout, /Installation complete!/);

    // Full tree is server data in the plugin dir (MCP catalog; stdio
    // list_skills additionally discloses skillRoot for direct reads); the
    // core meta-skills are additionally disclosed natively in the user and
    // project skill dirs.
    assert.equal(
      countSkills(join(home, '.codeartsdoer', 'skills')),
      coreSkillCount,
      'user skills dir carries the core meta-skills',
    );
    assert.equal(
      countSkills(join(cwd, '.codeartsdoer', 'skills')),
      coreSkillCount,
      'project skills dir carries the core meta-skills',
    );
    assert.ok(existsSync(join(home, '.codeartsdoer', 'skills', '.huaweicloud-devkit-native.json')));
    assert.ok(existsSync(join(cwd, '.codeartsdoer', 'skills', '.huaweicloud-devkit-native.json')));

    const pluginDir = join(home, '.codeartsdoer', 'huaweicloud-plugins');
    assert.ok(countSkills(join(pluginDir, 'skills')) >= 6, 'plugin dir carries the skills tree');
    assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pluginDir, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker in codearts plugins dir');
    assert.equal(mcpConfig(join(pluginDir, 'package.json'))?.version, pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts install writes correct mcp_settings.json at user and project level', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);

    for (const configPath of [
      join(home, '.codeartsdoer', 'mcp', 'mcp_settings.json'),
      join(cwd, '.codeartsdoer', 'mcp', 'mcp_settings.json'),
    ]) {
      const config = mcpConfig(configPath);
      assert.ok(config, `mcp config exists: ${configPath}`);
      const server = config.mcpServers?.['huaweicloud-devkit'];
      assert.ok(server, `huaweicloud-devkit server registered in ${configPath}`);
      assert.equal(server.command, 'node');
      assert.ok(
        server.args[0].endsWith('huaweicloud-plugins/dist/mcp-server.js'),
        `args[0] points to mcp-server.js: ${server.args[0]}`,
      );
      assert.equal(server.enabled, true);
      assert.equal(server.env?.HUAWEICLOUD_AGENT_TOOLKIT_MODE, 'local');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts status reports installed skills and configured MCP', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(install.status, 0, install.stderr);

    const res = runCli(home, cwd, ['status', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[CodeArts\]/);
    assert.match(res.stdout, /MCP Server: .*Installed/);
    assert.match(res.stdout, /Safety Policy: .*Installed/);
    assert.match(res.stdout, /Skills: .*\d+ installed/);
    assert.match(res.stdout, /MCP config: .*Configured/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts uninstall removes skills, plugins, and MCP config', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(install.status, 0, install.stderr);

    const res = runCli(home, cwd, ['uninstall', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Uninstall complete\./);

    assert.equal(countSkills(join(home, '.codeartsdoer', 'skills')), 0, 'user skills removed');
    assert.equal(countSkills(join(cwd, '.codeartsdoer', 'skills')), 0, 'project skills removed');
    assert.ok(!existsSync(join(home, '.codeartsdoer', 'huaweicloud-plugins')), 'plugins dir removed');
    assert.ok(
      !mcpConfig(join(home, '.codeartsdoer', 'mcp', 'mcp_settings.json'))?.mcpServers?.['huaweicloud-devkit'],
      'user MCP config cleaned',
    );
    assert.ok(
      !mcpConfig(join(cwd, '.codeartsdoer', 'mcp', 'mcp_settings.json'))?.mcpServers?.['huaweicloud-devkit'],
      'project MCP config cleaned',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts install respects existing unrelated MCP servers on uninstall', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const configPath = join(cwd, '.codeartsdoer', 'mcp', 'mcp_settings.json');
    mkdirSync(join(cwd, '.codeartsdoer', 'mcp'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'echo' } } }));

    const res = runCli(home, cwd, ['uninstall', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);
    const config = mcpConfig(configPath);
    assert.ok(!config.mcpServers?.['huaweicloud-devkit'], 'huaweicloud-devkit removed');
    assert.ok(config.mcpServers?.other, 'unrelated server preserved');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts install injects HCLOUD_BIN into MCP env when hcloud exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const binName = process.platform === 'win32' ? 'hcloud.exe' : 'hcloud';
    const binDir = process.platform === 'win32' ? join(home, 'hcloud') : join(home, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, binName), '');

    const res = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);

    const config = mcpConfig(join(home, '.codeartsdoer', 'mcp', 'mcp_settings.json'));
    const expected = join(binDir, binName).replace(/\\/g, '/');
    assert.equal(config.mcpServers['huaweicloud-devkit'].env.HCLOUD_BIN, expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help documents the codearts target', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-proj-'));
  try {
    const res = runCli(home, cwd, ['help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
    );
    assert.match(res.stdout, /install --target codearts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- CodeArts Work integration tests ---

test('codearts-work install copies skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(
      countSkills(join(home, '.codeartswork', 'skills')),
      coreSkillCount,
      'native skills dir carries the core meta-skills',
    );

    const pluginDir = join(home, '.codeartswork', 'huaweicloud-plugins');
    assert.ok(countSkills(join(pluginDir, 'skills')) >= 6, 'plugin dir carries the skills tree');
    assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')), 'MCP server');
    assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')), 'safety policy');
    assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work install writes correct mcp_settings.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);

    const config = mcpConfig(join(home, '.codeartswork', 'mcp', 'mcp_settings.json'));
    assert.ok(config, 'mcp_settings.json exists');
    const server = config.mcp['huaweicloud-devkit'];
    assert.ok(server, 'huaweicloud-devkit entry exists');
    assert.equal(server.type, 'local');
    assert.equal(server.enabled, true);
    assert.equal(server.timeout, 300000);
    assert.equal(server.command[0], 'node');
    assert.match(server.command[1], /huaweicloud-plugins[\\/]dist[\\/]mcp-server\.js/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work status reports installed skills and configured MCP', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(install.status, 0, install.stderr);

    const res = runCli(home, cwd, ['status', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installed/);
    assert.match(res.stdout, /Configured/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work uninstall removes skills, plugins, and MCP config', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(install.status, 0, install.stderr);

    const res = runCli(home, cwd, ['uninstall', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(countSkills(join(home, '.codeartswork', 'skills')), 0, 'skills removed');
    assert.ok(!existsSync(join(home, '.codeartswork', 'huaweicloud-plugins')), 'plugins dir removed');

    const config = mcpConfig(join(home, '.codeartswork', 'mcp', 'mcp_settings.json'));
    assert.ok(!config?.mcp?.['huaweicloud-devkit'], 'MCP config cleaned');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work appears in help output', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const res = runCli(home, cwd, ['help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy/);
    assert.match(res.stdout, /install --target codearts-work/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work install inherits user STS env from market-preset ~/.codearts peer key', () => {
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const presetDir = join(home, '.codearts', 'mcp');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(
      join(presetDir, 'mcp_settings.json'),
      JSON.stringify({
        mcp: {
          'huaweicloud-devkit_1': {
            type: 'local',
            command: ['npx', '-y', '-p', 'huaweicloud-devkit@latest', 'huaweicloud-devkit-mcp'],
            environment: {
              HW_ACCESS_KEY: 'INHERIT_AK',
              HW_SECRET_KEY: 'INHERIT_SK',
              HW_SECURITY_TOKEN: 'INHERIT_TOKEN',
              HW_REGION: 'cn-south-1',
            },
          },
        },
      }),
      'utf8',
    );
    const res = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);
    const config = mcpConfig(join(home, '.codearts', 'mcp', 'mcp_settings.json'));
    assert.ok(config, 'mcp_settings.json exists under ~/.codearts');
    const server = config.mcp['huaweicloud-devkit'];
    assert.ok(server, 'devkit-installed key exists alongside market-preset _1');
    assert.equal(server.environment.HW_ACCESS_KEY, 'INHERIT_AK');
    assert.equal(server.environment.HW_SECRET_KEY, 'INHERIT_SK');
    assert.equal(server.environment.HW_SECURITY_TOKEN, 'INHERIT_TOKEN');
    assert.equal(server.command[0], 'node');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codearts-work install writes mcp_settings with 0600 file / 0700 dir (R5)', () => {
  if (process.platform === 'win32') return; // POSIX-only permission semantics
  const home = mkdtempSync(join(tmpdir(), 'codearts-work-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codearts-work-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts-work']);
    assert.equal(res.status, 0, res.stderr);
    const file = join(home, '.codeartswork', 'mcp', 'mcp_settings.json');
    assert.ok(existsSync(file));
    const fmode = statSync(file).mode & 0o777;
    assert.equal(fmode, 0o600, `expected 0600, got ${fmode.toString(8)}`);
    const dmode = statSync(join(home, '.codeartswork', 'mcp')).mode & 0o777;
    assert.equal(dmode, 0o700, `expected 0700, got ${dmode.toString(8)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
