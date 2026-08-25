import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home) {
  return { ...process.env, USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) };
}

function run(target, home, cwd, cmd) {
  return spawnSync(process.execPath, [setupCli, cmd, '--target', target], {
    cwd,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function pluginVersion(pluginsDir) {
  const p = join(pluginsDir, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

test('opencode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.config', 'opencode', 'skills')) >= 6);
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.config', 'opencode', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assert.ok(countSkills(join(home, '.config', 'opencode', 'skills')) >= 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('workbuddy', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[WorkBuddy\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.workbuddy', 'skills')) >= 6);
    const pd = join(home, '.workbuddy', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.workbuddy', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assert.ok(countSkills(join(home, '.workbuddy', 'skills')) >= 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('codex-desktop', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Codex Desktop\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.agents', 'skills')) >= 6);
    const pd = join(home, '.agents', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
    const res = run('codex-desktop', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.agents', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.agents', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help lists supported agent targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = spawnSync(process.execPath, [setupCli, 'help'], {
      cwd,
      env: makeEnv(home),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.match(res.stdout, /install --target workbuddy/);
    assert.match(res.stdout, /install --target dsh/);
    assert.match(res.stdout, /install --target codearts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw install creates skills, MCP server, and safety policy in .agents', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('openclaw', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenClaw\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.agents', 'skills')) >= 6);
    const pd = join(home, '.agents', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('openclaw', home, cwd, 'install').status, 0);
    const res = run('openclaw', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.agents', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.agents', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('hermes', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Hermes Agent\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.hermes', 'skills')) >= 6);
    const pd = join(home, '.hermes', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('hermes', home, cwd, 'install').status, 0);
    const res = run('hermes', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.hermes', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.hermes', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex target does not crash without Codex CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('codex', home, cwd, 'install');
    assert.match(res.stdout, /Codex CLI not found/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
