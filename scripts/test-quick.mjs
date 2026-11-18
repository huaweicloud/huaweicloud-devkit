#!/usr/bin/env node
// The quick-layer runner (see scripts/lib/test-layers.mjs for the partition
// rules). A zero-file derivation is a hard error: node --test exits 0 on an
// empty run, so a derivation bug must never read as a green suite.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { partitionTests } from './lib/test-layers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { quick } = partitionTests(join(root, 'test'));
if (quick.length === 0) {
  console.error('test:quick derived an empty file list — refusing a green zero-test run');
  process.exitCode = 1;
} else {
  const run = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--test', ...quick.map((name) => join('test', name))],
    { cwd: root, stdio: 'inherit' },
  );
  process.exitCode = run.status ?? 1;
}
