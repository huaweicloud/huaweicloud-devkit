import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const fakeNodeVersionShim = join(root, 'test', 'fixtures', 'fake-node-version.cjs');

// Port of dev's test/node-floor-reject.test.mjs (cdc910f5) onto the v2 tree.
// The dev file exercised the rejection only on a genuinely below-floor CI
// lane (it skips wherever the host Node is supported); this port simulates
// the version inside the spawned child via a preload shim, so both sides of
// the floor run on every lane and every dev machine.

function makeEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
    // The pass-through case runs checkForUpdate before dispatch. A dead local
    // registry keeps that dist-tags fetch offline (the failure-tolerant fetch
    // resolves it to null), so the command proceeds into its normal flow.
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9/',
  };
  for (const key of [
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'HERMES_HOME',
    'DSH_HOME',
    'ATOMCODE_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'HCLOUD_BIN',
    'NODE_OPTIONS',
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(home: string, cwd: string, args: string[], nodeVersion: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--require', fakeNodeVersionShim, setupCli, ...args], {
    cwd,
    env: { ...makeEnv(home), FAKE_NODE_VERSION: nodeVersion },
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('version still runs below the declared node floor', () => {
  const home = fixtureDir('floor-reject-home-');
  const cwd = fixtureDir('floor-reject-proj-');
  const res = runCli(home, cwd, ['version'], '22.18.0');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /HuaweiCloud DevKit CLI:/);
});

test('install rejects a node below the declared floor with a clear message', () => {
  const home = fixtureDir('floor-reject-home-');
  const cwd = fixtureDir('floor-reject-proj-');
  const res = runCli(home, cwd, ['install', '--target', 'codearts'], '22.18.0');
  assert.notEqual(res.status, 0);
  const output = `${res.stdout}\n${res.stderr}`;
  assert.match(output, /Node\.js >= 22\.19 required \(current: v22\.18\.0\)/);
  assert.equal(readdirSync(home).length, 0, 'the rejection fires before any target dir or state file is created');
});

test('update rejects a node below the declared floor before touching any target', () => {
  const home = fixtureDir('floor-reject-home-');
  const cwd = fixtureDir('floor-reject-proj-');
  const res = runCli(home, cwd, ['update', '--target', 'codearts'], '22.18.0');
  assert.notEqual(res.status, 0, 'update must refuse to run below the floor');
  const output = `${res.stdout}\n${res.stderr}`;
  assert.match(output, /Node\.js >= 22\.19 required \(current: v22\.18\.0\)/);
  // The gate sits at the command entry, so a below-floor run never reaches
  // per-target dispatch, never reports per-target state, and never places a
  // payload.
  assert.doesNotMatch(output, /Not installed/);
  assert.doesNotMatch(output, /Update complete/);
  assert.equal(readdirSync(home).length, 0, 'the rejection fires before any payload or state file is written');
  assert.ok(!existsSync(join(cwd, '.codeartsdoer')), 'no project dir touched');
});

test('update passes the floor at Node 22.19 and reaches its normal flow', () => {
  const home = fixtureDir('floor-pass-home-');
  const cwd = fixtureDir('floor-pass-proj-');
  const res = runCli(home, cwd, ['update', '--target', 'codearts'], '22.19.0');
  const output = `${res.stdout}\n${res.stderr}`;
  // checkNode's pass line wraps OK in an ANSI color, so the match stops at the
  // version, not the literal suffix.
  assert.match(output, /Node\.js v22\.19\.0 .*OK/);
  assert.doesNotMatch(output, /Node\.js >= 22\.19 required/);
  // On a fresh home the gated command proceeds past the gate into its
  // normal per-target flow.
  assert.match(output, /Not installed/);
});
