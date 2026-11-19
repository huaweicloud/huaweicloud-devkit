// #1158 D9-12: the initialize handshake must trigger the KooCLI version check.
// The probe is hermetic: a fake hcloud binary answers `version`, so the test
// asserts the response carries the probe facts without touching the host CLI.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Keep the initialize-time hdkitservice user-hash probe off the network.
process.env.HDKITSERVICE_ENDPOINT = 'http://127.0.0.1:9';
process.env.HCLOUD_BIN = process.execPath;
process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-hcloud.mjs'),
]);

const { dispatch } = await import('../plugins/huaweicloud-core/src/mcp-protocol.mjs');

test('initialize surfaces the KooCLI version check (#1158 D9-12)', async () => {
  const result = await dispatch(
    'initialize',
    { clientInfo: {}, protocolVersion: '2024-11-05' },
    { sessionId: 'd912-version-check' },
  );
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.ok(result.serverInfo.kooCli, 'initialize must run runVersionCheck and report the facts');
  assert.equal(result.serverInfo.kooCli.installed, true);
  assert.equal(result.serverInfo.kooCli.installedVersion, '7.2.12');
  assert.equal(result.serverInfo.kooCli.status, 'version_mismatch');
  assert.equal(result.serverInfo.kooCli.versionMismatch, true);
});
