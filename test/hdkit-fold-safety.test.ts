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

// mock 路由共用跑法（round 16 去重）：设载体 → 跑真实 handleConnect → 复原，
// 返回折叠信封（拒绝与爆炸都是测试自身的失败）
async function foldViaHandler(carrier: unknown): Promise<Record<string, unknown>> {
  handlerCarrier = carrier;
  try {
    const out = (await handleConnect({ pool_type: 'ephemeral' }).then(
      (result: unknown) => result,
      () => null,
    )) as Record<string, unknown> | null;
    assert.ok(out, 'the fold envelope must fold — a rejection or null here fails the pin');
    return out;
  } finally {
    handlerCarrier = undefined;
  }
}

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
  const out = await foldViaHandler(
    fieldThrower('message', Object.assign(new Error('x'), { code: 'HDKIT_QUOTA_EXCEEDED' })),
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'HDKIT_QUOTA_EXCEEDED');
  assert.equal(out.message, '', 'a refusing message read is absent on the envelope');
});

// ── 信封窄化与 body-read 包装口（round 16）──
// handler 业务折叠的 retryAfter、耗尽折叠的 remediation 经真实 mock 路由钉
// BigInt 窄化；body-read catch 的裸 status 读在包装口自己的 catch 里引爆——
// text() 拒绝 + 敌意 status getter 不得浮出 TypeError。

test('a BigInt retryAfter through the handler business fold rides absent; the envelope serializes', async () => {
  const out = await foldViaHandler(
    Object.assign(new Error('x'), {
      code: 'HDKIT_QUOTA_EXCEEDED',
      retryAfter: 1n,
      remediation: { hint: '配额已满', steps: ['稍后重试'] },
    }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'HDKIT_QUOTA_EXCEEDED');
  assert.equal(out.retryAfter, undefined, 'the hostile retryAfter is absent');
  assert.equal((out.remediation as { hint: string }).hint, '配额已满');
  assert.doesNotThrow(() => {
    JSON.stringify(out);
  }, 'the business envelope JSON-serializes through the real route');
});

test('a BigInt remediation through the exhaustion fold rides absent; the envelope serializes', async () => {
  const out = await foldViaHandler(
    Object.assign(new Error('exhausted'), {
      gatewayRetryExhausted: true,
      connectRetries: 2,
      code: 'HDKIT_GATEWAY_TIMEOUT',
      remediation: 1n,
    }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.remediation, undefined, 'the hostile remediation is absent');
  assert.equal(out.connectRetries, 2);
  assert.doesNotThrow(() => {
    JSON.stringify(out);
  }, 'the exhaustion envelope JSON-serializes through the real route');
});

test('the body-read wrap survives a hostile response: a throwing text() plus a throwing status getter surfaces the designed envelope', async () => {
  const originalFetch = global.fetch;
  try {
    const hostileResponse = {
      get status(): number {
        throw new TypeError('status getter detonates');
      },
      text: () => {
        throw new TypeError('body read died mid-stream');
      },
    };
    global.fetch = (async () => hostileResponse) as unknown as typeof global.fetch;
    const outcome = await hdkitConnectWithRetry({}).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(outcome, 'expected rejection');
    const err = outcome as Error & { bodyUnreadable?: boolean; status?: unknown };
    assert.ok(!(err instanceof TypeError), 'the wrap never detonates in its own catch');
    assert.match(err.message, /body read died mid-stream/, 'the real reason carries through cleaned');
    assert.equal(err.bodyUnreadable, true, 'the wrap marker rides');
    assert.equal(err.status, undefined, 'a refusing status read is absent — no gateway signal');
  } finally {
    global.fetch = originalFetch;
  }
});
