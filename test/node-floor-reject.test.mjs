import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isSupportedNode } from '../plugins/huaweicloud-core/src/node-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const supported = isSupportedNode(process.versions.node);
const skipSupported = supported ? 'Node floor is supported' : false;

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

function runCli(home, cwd, args) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 600000,
  });
}

test('version still runs below the declared node floor', { skip: skipSupported }, () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-reject-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-reject-proj-'));
  try {
    const res = runCli(home, cwd, ['version']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /HuaweiCloud DevKit CLI:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install rejects a node below the declared floor with a clear message', { skip: skipSupported }, () => {
  const home = mkdtempSync(join(tmpdir(), 'floor-reject-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'floor-reject-proj-'));
  try {
    const res = runCli(home, cwd, ['install', '--target', 'codearts']);
    assert.notEqual(res.status, 0);
    const output = `${res.stdout}\n${res.stderr}`;
    assert.match(output, /Node\.js >= 22\.19/);
    assert.match(output, /23\.4/);
    assert.doesNotMatch(output, /No such built-in module/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
