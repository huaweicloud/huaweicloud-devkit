// ── 折叠口最后两处裸读与传输包装口（round 15）──
// handler 业务折叠（handlers-account）与 voucher 非门禁信封（voucherFallback）
// 是折叠出口里最后两处裸读；transportReason 的原型检查与消息读同样裸——
// 包装口全部的意义就是不信任来因形态。
// 注入路由：getCredentials 的抛出不经请求层包装、直达 voucherFallback 的
// catch；hdkitConnectWithRetry 经 mock 注入敌意载体、直达 handler 折叠。请求
// 层自建错误恒为诚实载体——敌意形态仅导出面可达（台账记录）。
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HW_SANDBOX_POOL_CACHE_PATH = '/tmp/opencode/pool-r15-fold-safety.json';
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const) {
  delete process.env[key];
}

const HWLINK_SPEC = '../plugins/huaweicloud-core/src/lib/hdkit/hwlink-api.ts';
const API_SPEC = '../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts';
const HANDLERS_SPEC = '../plugins/huaweicloud-core/src/packs/sandbox/handlers-account.ts';

// 敌意凭证：voucher 钉设为抛出载体（getCredentials 抛出直达 catch），
// transport 钉恢复诚实凭证。createConnection 同占位——handlers-account
// 的图经 hwlink-connection 于链接期要求该名存在，钉内从不调用
let credentialCarrier: unknown;
// @types/node 尚无 exports 字段（运行时已弃用 namedExports）——双重断言桥接
mock.module(HWLINK_SPEC, {
  exports: {
    getCredentials: (): { ak: string; sk: string; securitytoken: string } => {
      if (credentialCarrier !== undefined) throw credentialCarrier;
      return { ak: 'TESTAK', sk: 'TESTSK', securitytoken: '' };
    },
    createConnection: async (): Promise<never> => {
      throw new Error('fold-safety pin: createConnection is mocked away');
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

const { hdkitVoucherStatus, hdkitConnectWithRetry } = await import(API_SPEC);

function fieldThrower(field: string, base?: Error): Error {
  const carrier = base ?? new Error('the real diagnosis');
  Object.defineProperty(carrier, field, {
    get() {
      throw new TypeError(`${field} getter detonates`);
    },
    configurable: true,
  });
  return carrier;
}

test('a throwing message getter through the voucher envelope folds the unavailable copy, never a TypeError', async () => {
  credentialCarrier = fieldThrower('message');
  try {
    const envelope = (await hdkitVoucherStatus()) as Record<string, unknown>;
    assert.equal(envelope.claimed, false);
    assert.equal(
      envelope.message,
      'Incentive service unavailable, please try again later',
      'the refusing message read falls to the unavailable copy',
    );
    assert.equal(envelope.code, undefined, 'an absent code read is absent on the envelope');
  } finally {
    credentialCarrier = undefined;
  }
});

test('a revoked proxy through the voucher envelope folds the unavailable copy', async () => {
  const revoked = Proxy.revocable(new Error('revoked voucher carrier'), {});
  revoked.revoke();
  credentialCarrier = revoked.proxy;
  try {
    const envelope = (await hdkitVoucherStatus()) as Record<string, unknown>;
    assert.equal(envelope.claimed, false);
    assert.equal(envelope.message, 'Incentive service unavailable, please try again later');
  } finally {
    credentialCarrier = undefined;
  }
});

test('the transport wrap never trusts the rejection shape: throwing message getter and revoked proxy', async () => {
  const originalFetch = global.fetch;
  try {
    const revoked = Proxy.revocable(new Error('revoked transport carrier'), {});
    revoked.revoke();
    for (const [label, carrier] of [
      ['throwing message getter', fieldThrower('message', new Error('the real transport diagnosis'))],
      ['revoked proxy', revoked.proxy],
    ] as const) {
      global.fetch = (async () => {
        throw carrier;
      }) as typeof global.fetch;
      const outcome = await hdkitConnectWithRetry({}).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(outcome, `${label}: expected rejection`);
      const err = outcome as Error & { bodyUnreadable?: boolean };
      assert.equal(
        err.message,
        'hdkitservice request failed (no response)',
        `${label}: the wrap copy carries — never a TypeError from the wrap itself`,
      );
      assert.equal(err.bodyUnreadable, true, `${label}: the wrap marker rides`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

// handler 业务折叠：敌意载体经 mock 的 hdkitservice-api 注入（真实链路的错误
// 恒为请求层自建的诚实载体——mock 是导出面的唯一注入路由）
let handlerCarrier: unknown;
mock.module(API_SPEC, {
  exports: {
    hdkitConnectWithRetry: async () => {
      throw handlerCarrier;
    },
    hdkitCheckUser: async () => ({}),
    hdkitSignAgreement: async () => ({}),
  },
} as unknown as Parameters<typeof mock.module>[1]);
const { handleConnect } = await import(HANDLERS_SPEC);

test('a throwing code getter through the handler fold rethrows the original, never a TypeError', async () => {
  handlerCarrier = fieldThrower('code');
  try {
    const outcome = await handleConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(outcome, 'expected rejection');
    assert.ok(!(outcome instanceof TypeError), 'the fold never detonates — the original rethrows');
    assert.equal((outcome as Error).message, 'the real diagnosis');
  } finally {
    handlerCarrier = undefined;
  }
});

test('a quota code with a throwing message getter folds the business envelope with the message absent', async () => {
  handlerCarrier = fieldThrower('message', Object.assign(new Error('x'), { code: 'HDKIT_QUOTA_EXCEEDED' }));
  try {
    const out = (await handleConnect({ pool_type: 'ephemeral' }).then(
      (result: unknown) => result,
      () => null,
    )) as Record<string, unknown> | null;
    assert.ok(out, 'the business envelope folds');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'HDKIT_QUOTA_EXCEEDED');
    assert.equal(out.message, '', 'a refusing message read is absent on the envelope');
  } finally {
    handlerCarrier = undefined;
  }
});
