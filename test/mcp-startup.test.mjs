import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { maybePreinstallKooCli } from '../plugins/huaweicloud-core/src/preflight.mjs';

// NOTE: mcp-server.mjs starts the stdio server at module top-level
// (runStdioServer registers stdin/stdout listeners), so importing it directly
// would keep the test process alive and hang `node --test`. The wiring is
// asserted against the source instead, and the hook's guarded behavior is
// exercised against preflight.mjs directly with the skip flag set.
const serverSrc = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'plugins', 'huaweicloud-core', 'src', 'mcp-server.mjs'),
  'utf8',
);

// Skip flag is set for the whole test process: no real background install may
// ever be kicked off from a test (mirrors preflight.test.mjs / mcp-server.test.mjs).
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';

test('MCP server entry imports preflight with the expected hook', () => {
  assert.match(serverSrc, /import\s*\{\s*maybePreinstallKooCli\s*\}\s*from\s*'\.\/preflight\.mjs'/);
});

test('MCP server entry calls the preinstall hook non-blockingly at startup', () => {
  assert.match(serverSrc, /maybePreinstallKooCli\(\)/);
  assert.match(
    serverSrc,
    /maybePreinstallKooCli\(\s*\)\s*;\s*}\s*catch\s*{\s*}/,
    'hook must be swallowed by try/catch',
  );
});

test('preflight hook exists and returns immediately when the skip flag is set', () => {
  assert.equal(typeof maybePreinstallKooCli, 'function');
  process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
  const { launched, reason } = maybePreinstallKooCli();
  assert.equal(launched, false, 'must not launch with the skip flag set');
  assert.match(reason, /disabled/);
});
