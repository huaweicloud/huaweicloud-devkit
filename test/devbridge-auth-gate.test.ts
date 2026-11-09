import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _setOneShotForTests,
  gateExposeAuth,
  exposeTunnel,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import type { DevbridgeAuthGateOptions } from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import type { ExposeTunnelResult } from '../plugins/huaweicloud-core/src/sandbox/devbridge-expose.ts';
import type { OneShotResult } from '../plugins/huaweicloud-core/src/sandbox/devbridge-exec.ts';

// The gate's key-upgrade ladder (dev doctrine, 2026-11-04): probe → self-heal
// (dead cached key) → auto-create fallback → verdict. The key lifecycle fakes
// are injected (DevbridgeKeyUpgradeDeps), so no module mock is needed here.

const NO_KEY = 'DB_ATTEMPT_KEYRING=no-valid-key\nDB_ATTEMPT_APIKEY_FILE=no-file\nDB_AUTH_MODE=NO_CREDENTIAL\n';
const DEAD_KEY = 'DB_ATTEMPT_KEYRING=login-failed\nDB_ATTEMPT_APIKEY_FILE=no-file\nDB_AUTH_MODE=NO_CREDENTIAL\n';
const FILE_OK = 'DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=API_KEY_FILE\n';

interface FakeKeyLifecycle {
  ensureCalls: string[];
  recreateCalls: string[];
  injectCalls: string[];
  deps: DevbridgeAuthGateOptions;
  keyUpgrade: NonNullable<DevbridgeAuthGateOptions['keyUpgrade']>;
}

function fakeKeyLifecycle(
  overrides: {
    ensure?: (poolType: string | undefined | null) => Promise<{ apiKey: string; mode: string; ak: string }>;
    recreate?: (poolType: string | undefined | null) => Promise<{ apiKey: string; mode: string; ak: string }>;
    listKeys?: () => Promise<Array<{ name: string; id: string; lastUsed: string }>>;
  } = {},
): FakeKeyLifecycle {
  const defaultKey = async (_poolType: string | undefined | null) => ({
    apiKey: 'devbridge_FAKE',
    mode: 'CREATED',
    ak: 'AK',
  });
  const ensureCalls: string[] = [];
  const recreateCalls: string[] = [];
  const injectCalls: string[] = [];
  const keyUpgrade = {
    ensureDevbridgeKey: async (poolType: string | undefined | null) => {
      ensureCalls.push(String(poolType));
      return (overrides.ensure ?? defaultKey)(poolType);
    },
    recreateDevbridgeKey: async (poolType: string | undefined | null) => {
      recreateCalls.push(String(poolType));
      return (overrides.recreate ?? defaultKey)(poolType);
    },
    buildKeyringInjectScript: (apiKey: string) => {
      injectCalls.push(apiKey);
      return `inject:${apiKey}`;
    },
    listKeysForQuotaHint: overrides.listKeys ?? (async () => [{ name: 'stale-a', id: 'a', lastUsed: '2026-11-01' }]),
  };
  const deps = { poolType: undefined as string | undefined, keyUpgrade };
  return { ensureCalls, recreateCalls, injectCalls, deps, keyUpgrade };
}

async function withSeam(
  delegate: (command: string) => Promise<OneShotResult> | OneShotResult,
  fn: () => Promise<void>,
) {
  _setOneShotForTests(async (_ws, command) => delegate(command));
  try {
    await fn();
  } finally {
    _setOneShotForTests(null);
  }
}

// The two-round probe matcher shared by the ladder tests: probe #1 fails with
// `first`, the post-injection re-probe succeeds with `second`, and the inject
// call is recognized by its scripted prefix.
function twoProbeSeam(
  first: string,
  second: string,
): { seam: (command: string) => OneShotResult; probes: () => number } {
  let probeCount = 0;
  return {
    probes: () => probeCount,
    seam: (command) => {
      if (command.startsWith('inject:')) return { stdout: 'DB_KEY_INJECTED=1', exitCode: 0 };
      probeCount += 1;
      return { stdout: probeCount === 1 ? first : second, exitCode: 0 };
    },
  };
}

test('auto-create fallback: NO_CREDENTIAL probe → ensure → inject → re-probe → API_KEY_AUTO', async () => {
  const lifecycle = fakeKeyLifecycle();
  const { seam, probes } = twoProbeSeam(NO_KEY, FILE_OK);
  await withSeam(seam, async () => {
    const gate = await gateExposeAuth('ws-1', 'root', 8080, { ...lifecycle.deps, poolType: 'persistent' });
    assert.deepEqual(gate, { ok: true, authMode: 'API_KEY_AUTO', version: '' });
    // The pool type reaches the key factory (两池分流), the key is injected,
    // and the second probe re-runs the same waterfall script.
    assert.deepEqual(lifecycle.ensureCalls, ['persistent']);
    assert.deepEqual(lifecycle.injectCalls, ['devbridge_FAKE']);
    assert.equal(probes(), 2);
  });
});

test('self-heal: a dead cached key recreates first, and the generic fallback is skipped on success', async () => {
  const lifecycle = fakeKeyLifecycle();
  const { seam, probes } = twoProbeSeam(DEAD_KEY, FILE_OK);
  await withSeam(seam, async () => {
    const gate = await gateExposeAuth('ws-1', 'root', 8080, { ...lifecycle.deps, poolType: 'ephemeral' });
    assert.equal(gate.ok, true);
    assert.equal(gate.ok && gate.authMode, 'API_KEY_AUTO');
    assert.deepEqual(lifecycle.recreateCalls, ['ephemeral']);
    assert.deepEqual(lifecycle.ensureCalls, [], 'a healed key must not trigger a second create');
    assert.equal(probes(), 2);
  });
});

test('self-heal failure falls through to the generic auto-create fallback', async () => {
  const lifecycle = fakeKeyLifecycle({
    recreate: async () => {
      throw new Error('relay down');
    },
  });
  const { seam, probes } = twoProbeSeam(DEAD_KEY, FILE_OK);
  await withSeam(seam, async () => {
    const gate = await gateExposeAuth('ws-1', 'root', 8080, lifecycle.deps);
    assert.equal(gate.ok, true);
    assert.equal(gate.ok && gate.authMode, 'API_KEY_AUTO');
    assert.deepEqual(lifecycle.recreateCalls, ['ephemeral']);
    assert.deepEqual(lifecycle.ensureCalls, ['ephemeral']);
    assert.equal(probes(), 2);
  });
});

// Drive the gate over a constant NO_CREDENTIAL probe and return the failure
// object — the structured-degradation assertions share this harness.
async function failingGate(lifecycle: FakeKeyLifecycle, poolType?: string) {
  let failure: ExposeTunnelResult | undefined;
  await withSeam(
    () => ({ stdout: NO_KEY, exitCode: 0 }),
    async () => {
      const gate = await gateExposeAuth('ws-1', 'root', 8080, { ...lifecycle.deps, poolType });
      assert.equal(gate.ok, false);
      if (!gate.ok) failure = gate.failure;
    },
  );
  assert.ok(failure, 'the failing gate must carry its failure object');
  return failure;
}

test('quota exhaustion degrades to the structured failure with the key list and cleanup hint', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw Object.assign(new Error('HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED: 20 key limit'), {
        code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
      });
    },
    listKeys: async () => [
      { name: 'devkit-ephemeral', id: 'k1', lastUsed: '2026-11-04' },
      { name: 'stale-a', id: 'k2', lastUsed: '' },
    ],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.ok, false);
  assert.equal(f.error_code, 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED');
  assert.match(f.error ?? '', /20 key limit/);
  assert.equal(f.authMode, 'NO_CREDENTIAL');
  assert.deepEqual(f.attempts, { KEYRING: 'no-valid-key', APIKEY_FILE: 'no-file' });
  assert.deepEqual(f.currentKeys, [
    { name: 'devkit-ephemeral', id: 'k1', lastUsed: '2026-11-04' },
    { name: 'stale-a', id: 'k2', lastUsed: '' },
  ]);
  assert.match(f.hint ?? '', /API Key 数量已达上限/);
  assert.match(f.hint ?? '', /devkit-\* 开头的是插件自动管理的 key/);
  assert.equal(f.port, 8080);
});

test('a non-quota create failure keeps the plain no-credential degradation', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw new Error('network unreachable');
    },
  });
  const f = await failingGate(lifecycle);
  assert.equal(f.error_code, undefined);
  assert.equal(f.authMode, 'NO_CREDENTIAL');
  assert.match(f.hint ?? '', /No DevBridge API Key is available/);
  assert.match(f.hint ?? '', /quota \(20 key limit\)/);
});

test('the version gate precedes the key-upgrade ladder — no key is created for a 0.1.x binary', async () => {
  const lifecycle = fakeKeyLifecycle();
  let failure: ExposeTunnelResult | undefined;
  await withSeam(
    () => ({ stdout: `DB_VERSION=0.1.13-release\n${NO_KEY}`, exitCode: 0 }),
    async () => {
      const gate = await gateExposeAuth('ws-1', 'root', 8080, lifecycle.deps);
      assert.equal(gate.ok, false);
      if (!gate.ok) failure = gate.failure;
    },
  );
  assert.equal(failure?.error_code, 'devbridge_too_old');
  assert.deepEqual(lifecycle.ensureCalls, [], 'a permanent version blocker must not spend a key');
});

test('exposeTunnel short-circuits on the structured quota failure — the expose loop never runs', async () => {
  let exposeRan = false;
  await withSeam(
    (command) => {
      if (command.startsWith('inject:')) return { stdout: 'DB_KEY_INJECTED=1', exitCode: 0 };
      if (command.includes('nohup devbridge host')) exposeRan = true;
      return { stdout: NO_KEY, exitCode: 0 };
    },
    async () => {
      const result = await exposeTunnel(
        'ws-1',
        {
          port: 8080,
          keepalive: false,
          poolType: 'ephemeral',
          keyUpgrade: fakeKeyLifecycle({
            ensure: async () => {
              throw Object.assign(new Error('HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED: 20 key limit'), {
                code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
              });
            },
          }).keyUpgrade,
        },
        'root',
        90000,
      );
      assert.equal(result.ok, false);
      assert.equal(result.error_code, 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED');
      assert.ok(Array.isArray(result.currentKeys));
      assert.equal(exposeRan, false, 'a failed auth gate must never start a host');
    },
  );
});
