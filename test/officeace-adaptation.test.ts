import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

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

// Runs the CLI without OFFICE_CLAW_CONFIG_ROOT so OfficeAce root resolution
// is forced through the persisted marker / registry / Program Files probes.
function runCliNoEnv(home, cwd, args) {
  const env = makeEnv(home, join(home, '.office-claw'));
  delete env.OFFICE_CLAW_CONFIG_ROOT;
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function removeTempDir(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const MCP_CONNECTORS_SCHEMA =
  '(id TEXT PRIMARY KEY, owner_user_id TEXT, type TEXT, name TEXT, normalized_name TEXT, transport TEXT, ' +
  'timeout_ms INTEGER, command TEXT, args_json TEXT, env_json TEXT, enabled INTEGER, status TEXT, ' +
  'created_at INTEGER, updated_at INTEGER, version INTEGER, seeded INTEGER)';

// Creates OfficeAce's mcp-connectors.sqlite under <baseDir>/data (mirroring
// officeaceSqlitePath() = <config-root>/../data/mcp-connectors.sqlite).
function createOfficeaceDb(baseDir, seedRows = []) {
  const dbDir = join(baseDir, 'data');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, 'mcp-connectors.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_connectors ${MCP_CONNECTORS_SCHEMA}`);
  db.exec('CREATE TABLE IF NOT EXISTS mcp_connector_tools (connector_id TEXT)');
  const insert = db.prepare(
    `INSERT INTO mcp_connectors (id, owner_user_id, type, name, normalized_name, transport, timeout_ms, command, args_json, env_json, enabled, status, created_at, updated_at, version, seeded)
     VALUES (?, ?, 'custom', ?, ?, 'stdio', 60000, 'node', ?, '[]', 1, 'disconnected', 0, 0, 1, 0)`,
  );
  for (const row of seedRows) {
    insert.run(String(row.id), row.ownerUserId, row.name, row.name, row.argsJson);
  }
  db.close();
}

function queryDevkitRow(dbParentDir) {
  const db = new DatabaseSync(join(dbParentDir, 'data', 'mcp-connectors.sqlite'));
  const row = db.prepare("SELECT owner_user_id, args_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
  db.close();
  return row || null;
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
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(
      JSON.parse(readFileSync(join(pd, 'package.json'), 'utf8')).version,
      pkg.version,
      'officeace plugin package.json version matches package',
    );
  } finally {
    removeTempDir(home);
    removeTempDir(cwd);
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
    removeTempDir(home);
    removeTempDir(cwd);
  }
});

test('officeace uninstall→reinstall restores owner_user_id from backup (#559)', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'oa-proj-'));
  const oaHome = join(home, '.office-claw');
  mkdirSync(oaHome, { recursive: true });
  writeFileSync(join(oaHome, 'capabilities.json'), '{"capabilities":[]}');
  // Seed a devkit connector row with an owner and extra args.
  createOfficeaceDb(home, [
    {
      id: 'seed-1',
      ownerUserId: 'oa-user-1',
      name: 'huaweicloud-devkit',
      argsJson: '["/old/mcp-server.mjs","--flag"]',
    },
  ]);
  try {
    // Uninstall deletes the row and backs up ownerUserId + argsExtra.
    assert.equal(runCli(home, cwd, ['uninstall', '--target', 'officeace'], oaHome).status, 0);
    assert.equal(queryDevkitRow(home), null, 'connector row removed on uninstall');

    // Reinstall in a fresh process: table is now empty, so owner_user_id can
    // only come from the backup — previously this returned false and left the
    // connector unregistered ("disconnected").
    const res = runCli(home, cwd, ['install', '--target', 'officeace'], oaHome);
    assert.equal(res.status, 0, res.stderr);

    const row = queryDevkitRow(home);
    assert.ok(row, 'connector row re-created on reinstall');
    assert.equal(row.owner_user_id, 'oa-user-1', 'owner_user_id restored from backup');
    const args = JSON.parse(row.args_json);
    assert.deepEqual(args.slice(1), ['--flag'], 'custom args restored, path updated');
  } finally {
    removeTempDir(home);
    removeTempDir(cwd);
  }
});

test('officeace install fails loudly when owner_user_id is underivable (#559)', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'oa-proj-'));
  const oaHome = join(home, '.office-claw');
  mkdirSync(oaHome, { recursive: true });
  writeFileSync(join(oaHome, 'capabilities.json'), '{"capabilities":[]}');
  // Empty connector table and no backup — registration must fail loudly.
  createOfficeaceDb(home, []);
  try {
    const res = runCli(home, cwd, ['install', '--target', 'officeace'], oaHome);
    assert.notEqual(res.status, 0, 'install must fail when owner_user_id is underivable');
    assert.match(res.stdout, /owner_user_id/);
  } finally {
    removeTempDir(home);
    removeTempDir(cwd);
  }
});

test('officeace uninstall locates root via persisted marker across processes (#559)', () => {
  const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'oa-proj-'));
  // Non-standard install location, only discoverable via OFFICE_CLAW_CONFIG_ROOT
  // at install time — which does not survive to a later process.
  const nonStandardBase = join(home, 'non-standard-install');
  const nonStandard = join(nonStandardBase, '.office-claw');
  mkdirSync(nonStandard, { recursive: true });
  writeFileSync(join(nonStandard, 'capabilities.json'), '{"capabilities":[]}');
  createOfficeaceDb(nonStandardBase, [
    { id: 'seed-1', ownerUserId: 'oa-user-1', name: 'huaweicloud-devkit', argsJson: '["/x/mcp-server.mjs"]' },
  ]);
  try {
    assert.equal(runCli(home, cwd, ['install', '--target', 'officeace'], nonStandard).status, 0);
    const markerPath = join(home, '.config', 'huaweicloud', 'devkit-officeace-root.json');
    assert.ok(existsSync(markerPath), 'marker persists the resolved root');

    // New process without OFFICE_CLAW_CONFIG_ROOT: marker must locate the
    // non-standard root (previously fell back to ~/.office-claw and cleaned
    // the wrong directory).
    const res = runCliNoEnv(home, cwd, ['uninstall', '--target', 'officeace']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(countSkills(join(nonStandard, 'skills')), 0, 'non-standard skills cleaned');
    assert.ok(!existsSync(join(nonStandard, 'huaweicloud-plugins')));
  } finally {
    removeTempDir(home);
    removeTempDir(cwd);
  }
});
