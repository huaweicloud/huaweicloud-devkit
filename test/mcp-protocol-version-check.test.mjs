// #1158 D9-12: the initialize handshake must trigger the KooCLI version check.
// The probe is hermetic: a fake hcloud binary answers `version`, so the test
// asserts the response carries the probe facts without touching the host CLI.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Reachable from here through the initialize handshake, which dynamically
// imports sandbox/hdkitservice-api.mjs: a 409 version gate would otherwise spawn
// a REAL detached auto-upgrade runner on a non-CI machine (AGENTS.md).
process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';
// Keep the initialize-time hdkitservice user-hash probe off the network.
process.env.HDKITSERVICE_ENDPOINT = 'http://127.0.0.1:9';
process.env.HCLOUD_BIN = process.execPath;
process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-hcloud.mjs'),
]);

const { dispatch } = await import('../plugins/huaweicloud-core/src/mcp-protocol.mjs');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

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

test('initialize bounds a stuck KooCLI probe and still completes the handshake (#1158 D9-12)', async () => {
  const prevBin = process.env.HCLOUD_BIN;
  const prevArgs = process.env.HCLOUD_BIN_ARGS_JSON;
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([join(fixtures, 'fake-hcloud-hang.mjs')]);
  try {
    const started = Date.now();
    const result = await dispatch(
      'initialize',
      { clientInfo: {}, protocolVersion: '2024-11-05' },
      { sessionId: 'd912-probe-hang' },
    );
    const elapsed = Date.now() - started;
    // Probe failure is not a handshake failure: the protocol version and the
    // tool capability must still come back.
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.deepEqual(result.capabilities.tools, {});
    assert.equal(result.serverInfo.name, 'huaweicloud-devkit');
    // Bounded: the old unbounded probe held this for the 5 s spawnSync default.
    assert.ok(elapsed < 4000, `initialize must bound the KooCLI probe (took ${elapsed}ms)`);
  } finally {
    process.env.HCLOUD_BIN = prevBin;
    process.env.HCLOUD_BIN_ARGS_JSON = prevArgs;
  }
});
