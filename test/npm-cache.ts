import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One warm npm cache shared by every install-bearing test file. The spawned
// installers run `npm install undici` under a fake HOME, and a cold
// per-fixture cache puts a registry fetch on the critical path of every
// install test. AGENTS.md documents 79s on a bad registry day, and the
// 2026-11-14 interrogate round found two env builders with no cache at all,
// worth 76s in a single file. npm's cache is content-addressed, so sharing
// it across fixtures and runs is safe. Deliberately NOT a registered
// fixtureDir: the dir persists across runs within a boot session so every
// run after the first starts warm (the doctor-golden harness pins the same
// pattern). An empty or partially written cache degrades to a normal network
// install, and wiping the dir only costs one cold run.
//
// Lives here, not in fixture-dir.ts, so a per-test-cleaner file (the
// raw-mkdtempSync allowlist in structure.test.ts) can adopt the shared cache
// without taking on the fixtureDir registry's import-and-migrate obligation.
export function npmCacheEnv(): Record<string, string> {
  return {
    npm_config_cache: join(tmpdir(), 'huaweicloud-devkit-test-npm-cache'),
    npm_config_prefer_offline: 'true',
  };
}
