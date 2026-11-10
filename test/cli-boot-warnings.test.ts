import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { makeEnv, setupCli } from './agent-install-harness.ts';
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
  assert.doesNotMatch(
    res.stderr,
    /\(node:\d+\)/,
    `CLI boot must not print Node warning lines: ${res.stderr}`,
  );
});
