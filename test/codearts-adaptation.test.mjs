import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home, _cwd) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
  };
}

function runCli(home, cwd, args) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, cwd),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function mcpConfig(path) {
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

    const userSkills = countSkills(join(home, '.codeartsdoer', 'skills'));
    const projSkills = countSkills(join(cwd, '.codeartsdoer', 'skills'));
    assert.ok(userSkills >= 6, `expected >= 6 user skills, got ${userSkills}`);
    assert.equal(projSkills, userSkills, 'project skills match user skills');

    const pluginDir = join(home, '.codeartsdoer', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pluginDir, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pluginDir, 'src', 'tools.mjs')));
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
        server.args[0].endsWith('huaweicloud-plugins/src/mcp-server.mjs'),
        `args[0] points to mcp-server.mjs: ${server.args[0]}`,
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
