import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ENV_GATED_TESTS,
  FULL_ONLY_TESTS,
  isFamilyMember,
  listTestFiles,
  partitionTests,
} from '../scripts/lib/test-layers.mjs';
import { fixtureDir } from './fixture-dir.ts';
import { readJson, root } from './structure-helpers.ts';

// The two-layer test partition guard. scripts/lib/test-layers.mjs is the
// single source of truth for `npm run test:quick`'s file list; this suite
// pins its rules so the partition cannot rot silently:
//  - `node --test` exits 0 on a missing file (when mixed with real files)
//    and on a zero-test run, so neither the runner nor node itself reports
//    a narrowed or empty quick layer — the runner's empty-list refusal and
//    the pins below are the only alarms (the 2026-11-15 interrogate round's
//    mechanism probes).
//  - the offline canary in ci.yml's integration lane is the behavioral net
//    for the one class no import rule can see: an install-spawning test
//    that reaches setup.cjs through a scripts/lib helper (the
//    doctor-golden.test.ts counterexample that ran a real registry install
//    inside the quick layer).

test('package.json wires the quick layer: exact pretest:quick build hook and the shared runner', () => {
  const pkg = readJson(join(root, 'package.json')) as { scripts: Record<string, string> };
  // npm fires pre-hooks per EXACT script name: `pretest` does NOT cover
  // `test:quick` (verified against npm 11.20.0). The quick layer hard-requires
  // the build artifacts (skills-tree/structure/dist-bundle assert them), so
  // the explicit hook is load-bearing — without it a fresh clone's first
  // quick run fails with missing-tree errors instead of building.
  assert.equal(pkg.scripts['pretest:quick'], 'npm run build');
  assert.equal(pkg.scripts['test:quick'], 'node scripts/test-quick.mjs');
  // The runner must consume the shared partition module, not a private copy
  // of the rules — otherwise the guard below pins a list nothing enforces.
  const runner = readFileSync(join(root, 'scripts', 'test-quick.mjs'), 'utf8');
  assert.ok(
    runner.includes("partitionTests(join(root, 'test'))"),
    'test-quick.mjs must derive its list from lib/test-layers.mjs',
  );
  assert.ok(
    runner.includes('quick.length === 0'),
    'test-quick.mjs must refuse an empty derivation (node --test exits 0 on zero tests)',
  );
});

test('the hand-maintained layer sets name real files only', () => {
  for (const name of FULL_ONLY_TESTS) {
    assert.ok(
      existsSync(join(root, 'test', name)),
      `${name} is listed FULL_ONLY but no such test file exists — the set entry rotted`,
    );
  }
  for (const name of ENV_GATED_TESTS) {
    assert.ok(
      existsSync(join(root, 'test', name)),
      `${name} is listed ENV_GATED but no such test file exists — the set entry rotted`,
    );
  }
});

test('doctor-golden stays full-layer: it installs through scripts/lib, not a family harness', () => {
  const body = readFileSync(join(root, 'test', 'doctor-golden.test.ts'), 'utf8');
  assert.ok(
    !isFamilyMember(body),
    'doctor-golden.test.ts now imports a family harness — move the name out of FULL_ONLY so the import rule owns it',
  );
  assert.ok(
    body.includes('doctor-golden.mjs'),
    'doctor-golden.test.ts no longer reaches an install through scripts/lib/doctor-golden.mjs — re-classify it',
  );
});

test('the partition covers every on-disk test file with no overlap and no phantom', () => {
  const p = partitionTests(join(root, 'test'));
  const onDisk = listTestFiles(join(root, 'test'));
  const layered = [...p.quick, ...p.family, ...p.fullOnly, ...p.envGated].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(layered, onDisk, 'every on-disk test file must sit in exactly one layer');
  // Known install-spawners must land in the family — if the import rule
  // drifts (a renamed harness module, a new import style), these fail first.
  for (const anchor of [
    'agent-install-opencode.test.ts',
    'target-lifecycle.test.ts',
    'dsh-adaptation.test.ts',
    'doctor-ask-rule.test.ts',
    'dep-uninstall.test.ts',
  ]) {
    assert.ok(
      p.family.includes(anchor),
      `${anchor} must be family (install-spawning) — the family import rule drifted`,
    );
  }
  assert.ok(
    p.family.length >= 20,
    'the install family cannot shrink below its known size without a deliberate re-classification',
  );
  // A floor against a derivation bug mass-migrating files: the quick layer
  // is the large remainder, and the runner refuses the empty case, but a
  // half-broken regex could still hand most files to the family silently.
  assert.ok(p.quick.length > 100, 'the quick layer must stay the large remainder of the suite');
});

test('partition rules behave on a fixture tree: family imports, named sets, and derivation order', () => {
  const dir = fixtureDir('structure-layers-');
  const files = [
    { name: 'plain.test.ts', body: "import test from 'node:test';\n" },
    { name: 'family.test.ts', body: "import { run } from './agent-install-harness.ts';\n" },
    { name: 'cache-marker.test.ts', body: "import { npmCacheEnv } from './npm-cache.ts';\n" },
    { name: 'doctor-golden.test.ts', body: "import { fixtureDir } from './fixture-dir.ts';\n" },
    { name: 'real-agents.test.ts', body: "import test from 'node:test';\n" },
  ];
  for (const file of files) {
    assert.ok(!existsSync(join(dir, file.name)), `${file.name} must not exist yet (mkdtemp guarantee)`);
    writeFileSync(join(dir, file.name), file.body);
  }
  // A file the named sets reference but that does not exist must be visible
  // to the partition as env-gated/full-only regardless — the runner never
  // spawns it either way; the package-level test above catches the rot.
  const p = partitionTests(dir);
  assert.deepEqual(p.quick, ['plain.test.ts']);
  assert.deepEqual(p.family, ['cache-marker.test.ts', 'family.test.ts']);
  assert.deepEqual(p.fullOnly, ['doctor-golden.test.ts']);
  assert.deepEqual(p.envGated, ['real-agents.test.ts']);
  mkdirSync(dir, { recursive: true });
});
