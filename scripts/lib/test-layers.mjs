import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The two-layer test partition. Single source of truth for which test files
// `npm run test:quick` runs, shared with test/structure-layers.test.ts (the
// guard). `npm test` stays the FULL suite — every gate that names `npm test`
// (ci.yml's matrix, npm-publish.yml, RELEASING, CONTRIBUTING, the PR
// template) keeps running everything; the quick layer is the local inner
// loop only.
//
// Quick layer = every top-level test/*.test.ts EXCEPT:
//  - the install family: files importing any of the five install-spawning
//    harness modules. Importing one declares "this file spawns real
//    installs" — test/npm-cache.ts exists precisely so install-spawners can
//    opt into the shared warm cache, so importing it is a family marker too.
//  - FULL_ONLY_TESTS: install-spawning files that reach `setup.cjs install`
//    through scripts/lib helpers, bypassing every family harness. The
//    2026-11-15 interrogate round proved the import rule cannot see this
//    class (doctor-golden.test.ts ran a real registry install inside the
//    quick layer, red on a dead-registry day); the offline canary in
//    ci.yml's integration lane is the behavioral net that catches new
//    members — a quick-layer run with a dead registry reds on any network
//    install.
//  - ENV_GATED_TESTS: real-agent lifecycle tests that need real CLIs on
//    PATH (CI runs them in e2e-nightly.yml with DEVKIT_REAL_AGENT_TESTS=1).
//
// Because the quick list is derived from the directory, it cannot rot the
// way a hand-maintained manifest can: a renamed file never orphans (it
// re-derives), and a file deleted from disk never lingers as a phantom
// entry. The named sets above are the only hand-maintained part, and the
// guard asserts every one of their entries exists on disk.

const FAMILY_IMPORT_RE =
  /from\s+['"]\.\/(agent-install-harness|doctor-helpers|dep-provision-harness|plugins-e2e-harness|npm-cache)\.ts['"]/;

// doctor-golden.test.ts spawns `setup.cjs install --target opencode` through
// scripts/lib/doctor-golden.mjs's own env (its own $TMPDIR npm cache), so no
// family-harness import marks it. Keep the entry even if that changes: the
// guard fails if the name stops matching a real file, and a file that later
// migrates onto a family harness stays harmlessly over-excluded.
export const FULL_ONLY_TESTS = new Set(['doctor-golden.test.ts']);

export const ENV_GATED_TESTS = new Set(['real-agents.test.ts']);

export function listTestFiles(testDir) {
  return readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort((a, b) => a.localeCompare(b));
}

export function isFamilyMember(body) {
  return FAMILY_IMPORT_RE.test(body);
}

export function partitionTests(testDir) {
  const family = [];
  const quick = [];
  const fullOnly = [];
  const envGated = [];
  for (const name of listTestFiles(testDir)) {
    if (ENV_GATED_TESTS.has(name)) {
      envGated.push(name);
      continue;
    }
    if (FULL_ONLY_TESTS.has(name)) {
      fullOnly.push(name);
      continue;
    }
    const body = readFileSync(join(testDir, name), 'utf8');
    if (isFamilyMember(body)) family.push(name);
    else quick.push(name);
  }
  return { family, quick, fullOnly, envGated };
}
