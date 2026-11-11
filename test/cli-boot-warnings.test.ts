import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { makeEnv, run, setupCli } from './agent-install-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

test('CLI boot prints no Node warnings (experimental builtins stay lazy)', () => {
  // 2026-11-10 report: `npx huaweicloud-devkit install --target opencode`
  // printed "(node:xxxx) ExperimentalWarning: SQLite is an experimental
  // feature and might change at any time" mid-install — the OfficeAce
  // connector family required node:sqlite at module scope, so every CLI
  // boot (install included) paid the warning before any command logic ran.
  // On 24.x the builtin is stable and this passes trivially; the CI floor
  // lane (22.19.0, where the builtin still warns) is where a reintroduced
  // eager load fails this test. The structural half of the guard (a
  // module-scope node:sqlite scan that fails on any Node) lives in
  // structure.test.ts. `help` boots the full module graph and writes
  // nothing.
  const home = fixtureDir('cli-boot-warnings');
  const res = spawnSync(process.execPath, [setupCli, 'help'], {
    cwd: home,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usage: npx huaweicloud-devkit/);
  assert.doesNotMatch(res.stderr, /\(node:\d+\)/, `CLI boot must not print Node warning lines: ${res.stderr}`);
});

test('install prints no Node warnings (spawn args arrays never combine with shell)', () => {
  // 2026-11-10 report #2: the gateway-prompt line carried "(node:xxxx)
  // [DEP0190] DeprecationWarning: Passing args to a child process with
  // shell option true..." — installRuntimeDeps spawned npm with an args
  // array plus shell:true, and emitWarning defers the stderr write, so
  // the warning surfaced glued to the provisioning prompt one step later
  // (trace-deprecation named the frame). This is the install-bearing
  // half of the warning guard: a real payload placement plus the
  // runtime-deps npm spawn, the same network class every agent-install
  // test already runs (undici fetches into the fake HOME's cold cache).
  // Red before the string-command fix on Node 24, where DEP0190 fires;
  // the structural half (an args-array + shell scan) lives in
  // structure.test.ts.
  const home = fixtureDir('cli-install-warnings');
  const cwd = fixtureDir('cli-install-warnings-cwd');
  // --trace-deprecation rides the child env so a future args-array+shell
  // regression names its own call site in this assertion's message.
  const res = run('opencode', home, cwd, 'install', { NODE_OPTIONS: '--trace-deprecation' });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /\(node:\d+\)/, `install must not print Node warning lines: ${res.stderr}`);
});
