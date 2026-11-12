import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { needsSqliteFlag } from '../plugins/huaweicloud-core/src/node-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const flagNode = needsSqliteFlag(process.versions.node);
const skipWithoutFlagNode = flagNode ? false : 'node:sqlite is already available on this Node version';

function makeEnv(home) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
    OFFICE_CLAW_CONFIG_ROOT: join(home, '.office-claw'),
  };
  delete env.HCLOUD_BIN;
  delete env.HCDEVKIT_SQLITE_REEXEC;
  delete env.NODE_OPTIONS;
  return env;
}

function runCli(home, cwd, args, overrides = {}) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: { ...makeEnv(home), ...overrides },
    encoding: 'utf8',
    timeout: 600000,
  });
}

function createOfficeaceDb(home) {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const { mkdirSync } = require('node:fs');",
    "const { join } = require('node:path');",
    'const base = process.env.OA_HOME;',
    "mkdirSync(join(base, 'data'), { recursive: true });",
    "const db = new DatabaseSync(join(base, 'data', 'mcp-connectors.sqlite'));",
    'db.exec("CREATE TABLE mcp_connectors (id TEXT PRIMARY KEY, owner_user_id TEXT, type TEXT, name TEXT, normalized_name TEXT, transport TEXT, timeout_ms INTEGER, command TEXT, args_json TEXT, env_json TEXT, enabled INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER, version INTEGER, seeded INTEGER)");',
    "db.exec('CREATE TABLE mcp_connector_tools (connector_id TEXT)');",
    'db.prepare("INSERT INTO mcp_connectors (id, owner_user_id, type, name, normalized_name, transport, timeout_ms, command, args_json, env_json, enabled, status, created_at, updated_at, version, seeded) VALUES (?, ?, \'custom\', ?, ?, \'stdio\', 60000, \'node\', ?, \'[]\', 1, \'disconnected\', 0, 0, 1, 0)").run("seed-1", "oa-user-1", "huaweicloud-devkit", "huaweicloud-devkit", JSON.stringify(["/old/mcp-server.mjs"]));',
    'db.close();',
  ].join('\n');
  const res = spawnSync(process.execPath, ['--experimental-sqlite', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, OA_HOME: home, NODE_OPTIONS: '' },
    timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
}

function makeOfficeaceHome(home) {
  const oaHome = join(home, '.office-claw');
  mkdirSync(oaHome, { recursive: true });
  writeFileSync(join(oaHome, 'capabilities.json'), '{"capabilities":[]}');
  createOfficeaceDb(home);
}

function removeDirs(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('version runs on the declared node floor without a sqlite flag', () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-proj-'));
  try {
    const res = runCli(home, cwd, ['version']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /HuaweiCloud DevKit CLI:/);
    assert.doesNotMatch(res.stderr, /No such built-in module/);
  } finally {
    removeDirs(home, cwd);
  }
});

test('codearts install runs on the declared node floor without a sqlite flag', () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[CodeArts\]/);
    assert.ok(existsSync(join(home, '.codeartsdoer', 'skills')));
    assert.ok(existsSync(join(home, '.codeartsdoer', 'huaweicloud-plugins', 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(home, '.codeartsdoer', 'huaweicloud-plugins', 'safety', 'policy.json')));
    assert.doesNotMatch(res.stderr, /No such built-in module/);
  } finally {
    removeDirs(home, cwd);
  }
});

test(
  'officeace install enables --experimental-sqlite automatically on the node floor',
  { skip: skipWithoutFlagNode },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'floor-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'floor-proj-'));
    try {
      makeOfficeaceHome(home);
      const res = runCli(home, cwd, ['install', '--target', 'officeace']);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /\[OfficeAce\]/);
      assert.match(res.stderr, /enabling --experimental-sqlite/i);
      assert.doesNotMatch(res.stderr, /No such built-in module/);
    } finally {
      removeDirs(home, cwd);
    }
  },
);

test('officeace install without the flag or re-exec reports actionable guidance', { skip: skipWithoutFlagNode }, () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-proj-'));
  try {
    makeOfficeaceHome(home);
    const res = runCli(home, cwd, ['install', '--target', 'officeace'], {
      HCDEVKIT_SQLITE_REEXEC: '1',
    });
    assert.notEqual(res.status, 0);
    const output = `${res.stdout}\n${res.stderr}`;
    assert.match(output, /Node\.js >= 22\.5/);
    assert.match(output, /--experimental-sqlite/);
    assert.doesNotMatch(output, /No such built-in module/);
  } finally {
    removeDirs(home, cwd);
  }
});

test('officeace status reports unavailable instead of crashing without the flag', { skip: skipWithoutFlagNode }, () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-proj-'));
  try {
    makeOfficeaceHome(home);
    const res = runCli(home, cwd, ['status', '--target', 'officeace'], {
      HCDEVKIT_SQLITE_REEXEC: '1',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Unavailable/);
    assert.match(res.stdout, /--experimental-sqlite/);
    assert.doesNotMatch(res.stdout, /No such built-in module/);
  } finally {
    removeDirs(home, cwd);
  }
});
