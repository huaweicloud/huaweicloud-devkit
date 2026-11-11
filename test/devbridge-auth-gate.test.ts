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

// Drive the gate over a scripted probe stdout and return the failure
// object — the structured-degradation assertions share this harness (the
// constant-NO_CREDENTIAL default and the scripted cases alike).
async function failingGate(lifecycle: FakeKeyLifecycle, poolType?: string, stdout: string = NO_KEY) {
  let failure: ExposeTunnelResult | undefined;
  await withSeam(
    () => ({ stdout, exitCode: 0 }),
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

test('a non-gate create failure keeps the plain no-credential degradation', async () => {
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

// 构造带完整门禁载荷的错误（三个 relay 折叠用例共用同一形状）
// 构造带完整门禁载荷的错误（relay 折叠用例共用同一形状）；message/extra 可覆写
// （round 6：不可见消息与不可见版本字段用例共用此构建器）
function gateError(
  message = 'HDKIT_VERSION_TOO_OLD: 插件版本过旧，请升级至正式版 2.0.0 及以上。',
  extra: Record<string, unknown> = {},
): Error & { code?: string; clientVersion?: string; minVersion?: string } {
  return Object.assign(new Error(message), {
    code: 'HDKIT_VERSION_TOO_OLD',
    clientVersion: '2.0.0-next.0',
    minVersion: '2.0.0',
    remediation: {
      hint: '插件版本过旧（当前 2.0.0-next.0，需升级至正式版 2.0.0 及以上）：',
      steps: [
        '在终端执行：npx --yes huaweicloud-devkit@latest update --target <agent>',
        '升级完成后重启当前 Agent 会话（MCP 工具需重启才生效）',
        '也可直接调用 huaweicloud_upgrade 工具完成升级',
      ],
    },
    ...extra,
  });
}

test('the 409 version gate folds through the relay failure with the upgrade remediation', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw gateError();
    },
  });
  const f = await failingGate(lifecycle);
  // 门禁按 relay 出口折叠（v2 扩展）：不是凭证误诊——quota/NO_CREDENTIAL 引导
  // 不出现，升级引导穿透 expose 结果
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
  assert.match(f.error ?? '', /插件版本过旧/);
  assert.equal((f as { clientVersion?: string }).clientVersion, '2.0.0-next.0');
  assert.equal((f as { minVersion?: string }).minVersion, '2.0.0');
  const remediation = (f as { gateRemediation?: { hint: string; steps: string[] } }).gateRemediation;
  assert.ok(remediation, 'the gate remediation must reach the expose result');
  assert.match(remediation!.hint, /版本过旧/);
  assert.match(remediation!.steps.join(' '), /huaweicloud-devkit@latest update --target <agent>/);
  assert.match(remediation!.steps.join(' '), /huaweicloud_upgrade/);
  assert.doesNotMatch(
    f.hint ?? '',
    /No DevBridge API Key is available/,
    'the no-credential misdiagnosis must not fire',
  );
  assert.doesNotMatch(f.hint ?? '', /quota/, 'the quota guidance must not fire');
  assert.equal(f.port, 8080);
});

test('the quota flow folds the gate when the key-list read is itself gated', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw Object.assign(new Error('HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED: 20 key limit'), {
        code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
      });
    },
    listKeys: async () => {
      throw gateError();
    },
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  // 429 后配额引导的 currentKeys 读取遭遇 409：门禁优先——拿着读不出来的
  // key 清单教用户清 key 是误诊，升级引导穿透
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
  assert.equal((f as { currentKeys?: unknown }).currentKeys, undefined, 'the quota envelope must not surface');
  const remediation = (f as { gateRemediation?: { hint: string; steps: string[] } }).gateRemediation;
  assert.ok(remediation, 'the gate remediation must reach the expose result');
  assert.match(remediation!.hint, /版本过旧/);
  assert.doesNotMatch(f.hint ?? '', /quota/);
});

// 空白与纯不可见字符多形一例参数化（round 5 + round 6 扩类）：同一折叠路径，
// 同一兜底断言——round 6 把参数面扩到 Cf 类新收口码点
for (const [label, message] of [
  ['a zero-width gate message', '​'],
  ['a whitespace gate message', '   '],
  ['a soft-hyphen gate message', '\u00ad'],
  ['a bidi-override gate message', '\u202e'],
] as const) {
  test(`the relay fold never renders a blank error field for ${label}`, async () => {
    const lifecycle = fakeKeyLifecycle({
      ensure: async () => {
        return Promise.reject(gateError(message));
      },
    });
    const f = await failingGate(lifecycle, 'ephemeral');
    assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
    assert.ok((f.error ?? '').trim() !== '', 'the error field must not render visually blank');
    assert.match(f.error ?? '', /版本过旧/, 'the designed gate copy fires');
  });
}

test('the relay fold narrows invisible clientVersion and minVersion away', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      return Promise.reject(
        gateError('插件版本过旧，请升级至正式版 2.0.0 及以上。', {
          clientVersion: '\u200b',
          minVersion: '\u200d',
        }),
      );
    },
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
  const fRec = f as unknown as Record<string, unknown>;
  assert.equal('clientVersion' in fRec, false, 'an invisible version narrows away');
  assert.equal('minVersion' in fRec, false);
  const remediation = (f as { gateRemediation?: { hint: string } }).gateRemediation;
  assert.ok(remediation, 'the fold mints or passes the remediation');
});

test('a readable codeless 409 on the relay folds as the gate with the server copy', async () => {
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      return Promise.reject(Object.assign(new Error('插件版本过旧，请升级至正式版 2.0.0 及以上。'), { status: 409 }));
    },
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD', 'the codeless 409 is the gate on the relay too');
  assert.match(
    f.error ?? '',
    /插件版本过旧，请升级至正式版 2\.0\.0 及以上/,
    'the readable shape surfaces the server copy',
  );
  const remediation = (f as { gateRemediation?: { hint: string } }).gateRemediation;
  assert.ok(remediation, 'the unknown-version remediation mints');
  assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/, 'the misdiagnosis must not fire');
});

test('an aborted codeless 409 on the relay folds as the gate, not the no-credential misdiagnosis', async () => {
  const gateError = Object.assign(new TypeError('terminated'), { status: 409 });
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw gateError;
    },
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD', 'a codeless 409 is the gate by the module contract');
  assert.ok((f.error ?? '').trim() !== '', 'the error field must render real text');
  const remediation = (f as { gateRemediation?: { hint: string; steps: string[] } }).gateRemediation;
  assert.ok(remediation, 'the unknown-version fallback remediation must reach the expose result');
  assert.match(remediation!.hint, /当前 未知/);
  assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/, 'the misdiagnosis must not fire');
});

test('the self-heal catch folds the gate on the first gated relay call', async () => {
  const lifecycle = fakeKeyLifecycle({
    recreate: async () => {
      throw gateError();
    },
  });
  const f = await failingGate(lifecycle, undefined, DEAD_KEY);
  assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
  assert.equal((f as { clientVersion?: string }).clientVersion, '2.0.0-next.0');
  const remediation = (f as { gateRemediation?: { hint: string; steps: string[] } }).gateRemediation;
  assert.ok(remediation, 'the gate remediation must surface on the first gated call');
  assert.deepEqual(lifecycle.ensureCalls, [], 'the generic ladder round must never run for a gated client');
});

test('the version gate precedes the key-upgrade ladder — no key is created for a 0.1.x binary', async () => {
  const lifecycle = fakeKeyLifecycle();
  const f = await failingGate(lifecycle, undefined, `DB_VERSION=0.1.13-release\n${NO_KEY}`);
  assert.equal(f.error_code, 'devbridge_too_old');
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
