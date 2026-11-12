import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

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

test('a woven devbridge quota code surfaces the quota envelope, never the no-credential misdiagnosis', async () => {
  // 内部织入形态（round 14 台账）：真实链路会把边缘垫入清掉——edge-padded
  // 夹具不可达，内部织入才是生产可达的拼写
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw Object.assign(new Error('HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEE\u200bDED: 20 key limit'), {
        code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEE\u200bDED',
      });
    },
    listKeys: async () => [{ name: 'stale-a', id: 'a', lastUsed: '2026-11-01' }],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED', 'the woven quota code is recognized canonically');
  assert.match(f.error ?? '', /20 key limit/);
  assert.ok(Array.isArray((f as { currentKeys?: unknown }).currentKeys), 'the quota envelope carries the key list');
  assert.match(f.hint ?? '', /API Key 数量已达上限/, 'the quota guidance fires — not the misdiagnosis');
  assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/);
});

// ── relay 捕获的裸读收口（round 14）──
// 配额分支的属性取值（canonCode 的读一半）与配额信封的 message 读仍裸——
// 两条都在同一 catch 里安全的 isVersionGateError 之前求值：拒读载体到达设计
// 的泛化降级信封，配额消息拒读时配额信封照常折叠，都不再 TypeError。

test('a refusing code read through the relay catch degrades designed, never a TypeError', async () => {
  const thrower = new Error('whatever the chain threw');
  Object.defineProperty(thrower, 'code', {
    get() {
      throw new TypeError('code getter detonates');
    },
    configurable: true,
  });
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw thrower;
    },
    listKeys: async () => [],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, undefined, 'a refusing code read is absent — no quota branch');
  assert.match(f.error ?? '', /no usable credential in the sandbox/, 'the generic degradation envelope fires');
  assert.match(
    f.hint ?? '',
    /No DevBridge API Key is available/,
    'the no-credential guidance — the designed fallback for an unreadable auto-create failure',
  );
});

test('a revoked proxy through the relay catch degrades designed, never a TypeError', async () => {
  const revoked = Proxy.revocable(new Error('revoked carrier'), {});
  revoked.revoke();
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw revoked.proxy;
    },
    listKeys: async () => [],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, undefined, 'a revoked proxy reads absent — no quota branch');
  assert.match(f.error ?? '', /no usable credential in the sandbox/, 'the generic degradation envelope fires');
});

test('a quota code with a refusing message read still folds the quota envelope', async () => {
  const carrier = Object.assign(new Error('never read'), { code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED' });
  Object.defineProperty(carrier, 'message', {
    get() {
      throw new TypeError('message getter detonates');
    },
    configurable: true,
  });
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw carrier;
    },
    listKeys: async () => [{ name: 'stale-a', id: 'a', lastUsed: '2026-11-01' }],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(f.error_code, 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED', 'the quota branch fires');
  assert.equal(f.error, undefined, 'a refusing message read is absent — the field is omitted');
  assert.ok(Array.isArray((f as { currentKeys?: unknown }).currentKeys), 'the key list still rides');
  assert.match(f.hint ?? '', /API Key 数量已达上限/, 'the quota guidance fires');
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

test('a blank-code 409 on the relay folds as the gate, not the credential misdiagnosis', async () => {
  for (const blankCode of ['   ', '​'] as const) {
    const lifecycle = fakeKeyLifecycle({
      ensure: async () => {
        return Promise.reject(
          Object.assign(new Error('插件版本过旧，请升级至正式版 2.0.0 及以上。'), {
            code: blankCode,
            status: 409,
          }),
        );
      },
    });
    const f = await failingGate(lifecycle, 'ephemeral');
    assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD', 'a blank code is absent to the recognizer');
    assert.match(f.error ?? '', /插件版本过旧，请升级至正式版 2\.0\.0 及以上/);
    assert.ok((f as { gateRemediation?: { hint: string } }).gateRemediation, 'the remediation mints');
    assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/, 'the misdiagnosis must not fire');
  }
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

// ── 真实 relay 链路（round 8）：请求层码清洗直达 relay 折叠 ──
// 驱动真实 devbridge-key + 真实 hdkitRequest（fetch 打桩）——DI 空白码与
// 星面区垫码在请求层清洗后，relay 折叠为门禁而非凭证误诊。

test('the real relay path under a VS17-only or astral-padded gate code folds as the gate', async () => {
  const tmpHome = fixtureDir('relay-astral-home-');
  const realHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.HW_ACCESS_KEY = 'TESTAK';
  process.env.HW_SECRET_KEY = 'TESTSK';
  process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
  const restoreEnv = isolateDirectFetchEnv();
  const keyMod = await import('../plugins/huaweicloud-core/src/sandbox/devbridge-key.ts');
  const originalFetch = global.fetch;
  try {
    for (const code of [
      'HDKIT_VERSION_TOO_OLD󠄀',
      'HDKIT_VERSION_TOO_OLD\uFFF9',
      'HDKIT_VERSION_T\u200bOO_OLD',
      '󠄀',
    ] as const) {
      global.fetch = async () =>
        new Response(JSON.stringify({ code, message: '插件版本过旧，请升级至正式版 2.0.0 及以上。' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      await withSeam(
        async () => ({ stdout: NO_KEY, exitCode: 0 }),
        async () => {
          const gate = await gateExposeAuth('ws-1', 'root', 8080, {
            poolType: 'ephemeral',
            keyUpgrade: {
              ensureDevbridgeKey: keyMod.ensureDevbridgeKey,
              recreateDevbridgeKey: keyMod.recreateDevbridgeKey,
              buildKeyringInjectScript: keyMod.buildKeyringInjectScript,
              listKeysForQuotaHint: keyMod.listKeysForQuotaHint,
            },
          });
          assert.equal(gate.ok, false);
          if (gate.ok) return;
          const f = gate.failure;
          assert.equal(f.error_code, 'HDKIT_VERSION_TOO_OLD');
          assert.match(f.error ?? '', /插件版本过旧/, 'the server copy surfaces through the real chain');
          assert.ok((f as { gateRemediation?: { hint: string } }).gateRemediation, 'the gate remediation mints');
          assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/, 'the misdiagnosis must not fire');
        },
      );
    }
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

// ── 中继检测器先查登记（round 23/MUST 6）──
// 中继出口以 isVersionGateError 先于折叠裁决——登记过的门禁载体 code 视图
// 变坏（抛出型 getter）时检测器返回 false，出口落向凭证误诊/吞门禁，而折
// 叠本会铸造。检测器先查门禁登记：与折叠同一规则。

test('the relay detector consults the registration first: a registered gate carrier with a throwing code getter folds the gate at the relay', async () => {
  const { applyVersionGate } = await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkit-gate.ts');
  // 登记：自有 clientVersion 访问器（读谎）挣得门禁拒绝
  const carrier = Object.assign(new Error('gate'), { code: 'HDKIT_VERSION_TOO_OLD' });
  let storedCv: unknown;
  Object.defineProperty(carrier, 'clientVersion', {
    configurable: true,
    enumerable: true,
    get() {
      return storedCv;
    },
    set(v: unknown) {
      storedCv = v;
    },
  });
  applyVersionGate(carrier, { clientVersion: '2.0.0-next.0' });
  // code 视图变坏：抛出型 getter——检测器与折叠都不得读它
  Object.defineProperty(carrier, 'code', {
    get() {
      throw new TypeError('code getter detonates');
    },
    configurable: true,
  });
  const lifecycle = fakeKeyLifecycle({
    ensure: async () => {
      throw carrier;
    },
    listKeys: async () => [],
  });
  const f = await failingGate(lifecycle, 'ephemeral');
  assert.equal(
    f.error_code,
    'HDKIT_VERSION_TOO_OLD',
    'the relay detector mints the gate — the registration decides, never the detonating code view',
  );
  assert.match(f.error ?? '', /插件版本过旧，请升级插件后重启会话/, 'the registered fallback message carries');
  assert.ok((f as { gateRemediation?: { hint: string } }).gateRemediation, 'the unknown-version remediation mints');
  assert.doesNotMatch(f.hint ?? '', /No DevBridge API Key is available/, 'the credential misdiagnosis never fires');
});
