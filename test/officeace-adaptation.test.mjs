import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home, officeaceConfigRoot) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    OFFICE_CLAW_CONFIG_ROOT: officeaceConfigRoot,
  };
}

function runCli(home, cwd, args, officeaceConfigRoot = join(home, '.office-claw')) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, officeaceConfigRoot),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

test('officeace install copies skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'oa-proj-'));
  const oaHome = join(home, '.office-claw');
  mkdirSync(oaHome, { recursive: true });
  writeFileSync(join(oaHome, 'capabilities.json'), '{"capabilities":[]}');
  try {
    const res = runCli(home, cwd, ['install', '--target', 'officeace'], oaHome);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OfficeAce\]/);
    assert.ok(countSkills(join(oaHome, 'skills')) >= 6);
    const pd = join(oaHome, 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(
      JSON.parse(readFileSync(join(pd, 'package.json'), 'utf8')).version,
      pkg.version,
      'officeace plugin package.json version matches package',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('officeace uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'oa-proj-'));
  const oaHome = join(home, '.office-claw');
  mkdirSync(oaHome, { recursive: true });
  writeFileSync(join(oaHome, 'capabilities.json'), '{"capabilities":[]}');
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'officeace'], oaHome).status, 0);
    const res = runCli(home, cwd, ['uninstall', '--target', 'officeace'], oaHome);
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(oaHome, 'skills')), 0);
    assert.ok(!existsSync(join(oaHome, 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
