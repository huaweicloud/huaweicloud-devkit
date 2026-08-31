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

function runCli(home, cwd, args, dshHome = join(home, '.dsh')) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, dshHome),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function readPatch(dshHome) {
  const patchFile = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  return existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
}

function countMcpRows(patch) {
  return (patch.match(/id: mcp-huaweicloud/g) || []).length;
}

test('dsh install copies skills, MCP server, safety policy, and patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh-custom');
    const res = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[DSH\]/);
    assert.match(res.stdout, /Installation complete!/);

    assert.ok(countSkills(join(dshHome, 'skills')) >= 6, 'DSH skills installed');
    const pluginDir = join(dshHome, 'huaweicloud-plugins');
    assert.ok(existsSync(join(pluginDir, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pluginDir, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pluginDir, '.installed')));
    assert.equal(
      JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version,
      pkg.version,
      'dsh plugin package.json version matches package',
    );

    const patch = readPatch(dshHome);
    assert.match(patch, /id: mcp-huaweicloud/);
    assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(patch, /serverName: huaweicloud/);
    assert.match(patch, /transport: stdio/);
    assert.match(patch, /failOnStartupError: false/);
    assert.match(patch, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: local/);
    assert.match(patch, /HDKITSERVICE_ENDPOINT: ''/);
    assert.doesNotMatch(patch, /\\/);
    assert.match(patch, /huaweicloud-plugins\/src\/mcp-server\.mjs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh install writes .installed marker only after runtime deps', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const res = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(res.status, 0, res.stderr);
    const pluginDir = join(dshHome, 'huaweicloud-plugins');
    assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker exists');
    const hasUndici = existsSync(join(pluginDir, 'node_modules', 'undici'));
    assert.ok(hasUndici, 'undici installed before .installed marker written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh install is idempotent and preserves unrelated patch entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    const patchFile = join(profileDir, 'cordis.patch.yml');
    const existingPatch = [
      '# user patch',
      '- insert:',
      '    - id: user-plugin',
      "      name: '@example/user-plugin'",
      '',
    ].join('\n');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(patchFile, existingPatch);

    const first = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(first.status, 0, first.stderr);
    const second = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(second.status, 0, second.stderr);

    const patch = readPatch(dshHome);
    assert.equal(countMcpRows(patch), 1, patch);
    assert.match(patch, /id: user-plugin/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh update refreshes installed files and keeps one patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const update = runCli(home, cwd, ['update', '--target', 'dsh'], dshHome);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /Update complete/);

    assert.ok(existsSync(join(dshHome, 'huaweicloud-plugins', 'src', 'mcp-server.mjs')));
    assert.ok(countSkills(join(dshHome, 'skills')) >= 6);
    assert.equal(countMcpRows(readPatch(dshHome)), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh status reports installed files and patch configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const status = runCli(home, cwd, ['status', '--target', 'dsh'], dshHome);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /\[DSH\]/);
    assert.match(status.stdout, /MCP Server: .*Installed/);
    assert.match(status.stdout, /Safety Policy: .*Installed/);
    assert.match(status.stdout, /Skills: .*\d+ installed/);
    assert.match(status.stdout, /DSH patch: .*Configured/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh uninstall removes installed files and only the managed patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const uninstall = runCli(home, cwd, ['uninstall', '--target', 'dsh'], dshHome);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /Uninstall complete\./);

    assert.equal(countSkills(join(dshHome, 'skills')), 0, 'DSH skills removed');
    assert.ok(!existsSync(join(dshHome, 'skills')), 'empty DSH skills dir removed');
    assert.ok(!existsSync(join(dshHome, 'huaweicloud-plugins')), 'DSH plugin dir removed');
    const patch = readPatch(dshHome);
    assert.equal(countMcpRows(patch), 0, patch);
    assert.doesNotMatch(patch, /@deepseek-ai\/dsh-mcp-client/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh uninstall preserves non-Huawei skills directory entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const customSkillDir = join(dshHome, 'skills', 'custom-skill');
    mkdirSync(customSkillDir, { recursive: true });
    writeFileSync(join(customSkillDir, 'SKILL.md'), 'name: custom-skill\n');

    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const uninstall = runCli(home, cwd, ['uninstall', '--target', 'dsh'], dshHome);
    assert.equal(uninstall.status, 0, uninstall.stderr);

    assert.ok(existsSync(customSkillDir), 'custom skill preserved');
    assert.equal(countSkills(join(dshHome, 'skills')), 0, 'Huawei skills removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help documents the dsh target', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const res = runCli(home, cwd, ['help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
    );
    assert.match(res.stdout, /install --target dsh/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
