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
const { transientExhaustionResult, versionGateResult } =
  await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkit-gate.ts');

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

test('a BigInt remediation at the exhaustion fold mints the designed transient guidance through the real route', async () => {
  const out = await foldViaHandler(
    Object.assign(new Error('exhausted'), {
      gatewayRetryExhausted: true,
      connectRetries: 2,
      code: 'HDKIT_GATEWAY_TIMEOUT',
      remediation: 1n,
    }),
  );
  assert.equal(out.ok, false);
  const remediation = out.remediation as { hint?: string } | undefined;
  assert.match(
    String(remediation?.hint ?? ''),
    /连续遭遇网关 502\/504 超时/,
    'the hostile remediation is replaced by the designed transient guidance — never dropped (round 17)',
  );
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

// ── 判别器在站点 3/4 与 resp 接缝的收口（round 17）──
// toJSON 上下文判别器同样在 handler 业务折叠与 voucher 信封通关；resp 接缝
// 的五个裸读（非 JSON 两读、!ok、无码三元、429 双 headers.get）在各自分支
// 里把设计信封换成 TypeError。

test('a toJSON context discriminator never rides the handler business or voucher envelopes', async () => {
  const hostile = () => ({
    hint: 'hostile hint',
    steps: ['hostile step'],
    toJSON(key: string) {
      return key === '' ? { hint: 'safe view', steps: [] } : { hint: 1n, steps: [] };
    },
  });
  // 站点 3：handler 业务折叠——判别器被拒，配额码照骑，信封可序列化
  const out = await foldViaHandler(
    Object.assign(new Error('x'), {
      code: 'HDKIT_QUOTA_EXCEEDED',
      remediation: hostile(),
    }),
  );
  assert.equal(out.code, 'HDKIT_QUOTA_EXCEEDED');
  assert.equal(
    out.remediation,
    undefined,
    'the discriminator is rejected — no remediation rides the business envelope',
  );
  assert.doesNotThrow(() => {
    JSON.stringify(out, null, 2);
  }, 'site 3: the boundary-form serialization succeeds');
  // 站点 4：voucher 非门禁信封——判别器被拒，claimed:false 照骑
  credentialCarrier = Object.assign(new Error('x'), { remediation: hostile() });
  try {
    const envelope = (await hdkitVoucherStatus()) as Record<string, unknown>;
    assert.equal(envelope.claimed, false);
    assert.equal(envelope.remediation, undefined, 'the discriminator is rejected at the voucher envelope');
    assert.doesNotThrow(() => {
      JSON.stringify(envelope, null, 2);
    }, 'site 4: the boundary-form serialization succeeds');
  } finally {
    credentialCarrier = undefined;
  }
});

// 敌意响应对象的共用跑法（round 17 去重）：装 fetch 桩 → 跑真实连接 → 收
// 拒绝 → 复原。返回浮出的错误（测试自身的失败传 null）
async function rejectViaHostileResponse(response: unknown): Promise<Error> {
  const originalFetch = global.fetch;
  global.fetch = (async () => response) as typeof global.fetch;
  try {
    const outcome = await hdkitConnectWithRetry({}).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(outcome, 'expected rejection from the hostile response');
    return outcome as Error;
  } finally {
    global.fetch = originalFetch;
  }
}

test('the non-JSON branch survives a throwing status getter: the designed wrap carries, no TypeError', async () => {
  const err = (await rejectViaHostileResponse({
    get status(): number {
      throw new TypeError('status getter detonates');
    },
    text: async () => '<html>not json</html>',
  })) as Error & { bodyUnreadable?: boolean; status?: unknown };
  assert.ok(!(err instanceof TypeError), 'the non-JSON branch never detonates on a hostile status read');
  assert.match(err.message, /non-JSON/, 'the designed non-JSON wrap carries');
  assert.match(
    err.message,
    /status 未知/,
    'the absent status renders 未知 — never a manufactured literal (round 18 判别式)',
  );
  assert.equal(err.bodyUnreadable, true, 'the wrap marker rides');
  assert.equal(err.status, undefined, 'a refusing status read attaches nothing');
});

test('the error branch survives a throwing ok getter: the designed error envelope carries', async () => {
  const err = (await rejectViaHostileResponse({
    status: 500,
    get ok(): boolean {
      throw new TypeError('ok getter detonates');
    },
    text: async () => JSON.stringify({ code: 'HDKIT_INTERNAL', message: 'server error' }),
  })) as Error & { code?: string; status?: unknown };
  assert.ok(!(err instanceof TypeError), 'the error branch never detonates on a hostile ok read');
  assert.equal(err.code, 'HDKIT_INTERNAL', 'the server code rides');
  assert.equal(err.status, 500, 'the honest status attaches');
});

test('the codeless ternary survives a throwing status getter: no manufactured undefined literal', async () => {
  const err = await rejectViaHostileResponse({
    get status(): number {
      throw new TypeError('status getter detonates');
    },
    ok: false,
    text: async () => JSON.stringify({ message: 'gateway busy' }),
  });
  assert.ok(!(err instanceof TypeError), 'the ternary never detonates on a hostile status read');
  assert.equal(
    (err as { code?: unknown }).code,
    undefined,
    'no server code, no manufacture — never the literal "HTTP_undefined"',
  );
  assert.notEqual(err.message, 'HTTP_undefined: gateway busy');
  assert.match(err.message, /gateway busy/);
});

test('the 429 quota branch survives a throwing headers.get: the quota envelope carries, retryAfter absent', async () => {
  const err = (await rejectViaHostileResponse({
    status: 429,
    ok: false,
    headers: {
      get(name: string): string {
        throw new TypeError('headers.get detonates');
      },
    },
    text: async () => JSON.stringify({ code: 'HDKIT_QUOTA_EXCEEDED', message: 'quota full' }),
  })) as Error & { code?: string; retryAfter?: unknown; remediation?: { hint?: string } };
  assert.ok(!(err instanceof TypeError), 'the quota branch never detonates on a hostile header read');
  assert.equal(err.code, 'HDKIT_QUOTA_EXCEEDED', 'the quota code rides');
  assert.equal(err.retryAfter, undefined, 'a refusing header read attaches nothing');
  assert.match(err.remediation?.hint ?? '', /配额已满/, 'the quota remediation still rides');
});

// ── 敌意体与非有限状态（round 18）──
// text() 可 resolve 出任意值——非字符串在非 JSON catch 里裸做 text.slice，
// 原始 TypeError 顶替设计信封：409 门禁折叠死、502 不再重试。status 窄化只
// 看 typeof——NaN/Infinity 被伪造成 HTTP_NaN/HTTP_Infinity。

test('a text() resolving to a non-string is a hostile body: the 409 folds as the gate', async () => {
  for (const [label, body] of [
    ['object', { deep: true }],
    ['undefined', undefined],
    ['number', 123],
  ] as const) {
    const err = (await rejectViaHostileResponse({
      status: 409,
      ok: false,
      text: async () => body,
    })) as Error & { status?: unknown; bodyUnreadable?: boolean };
    assert.ok(!(err instanceof TypeError), `${label}: never a raw TypeError`);
    assert.equal(err.bodyUnreadable, true, `${label}: the wrap marker rides`);
    assert.equal(err.status, 409, `${label}: the honest status attaches`);
    const gate = versionGateResult(err);
    assert.equal(gate?.code, 'HDKIT_VERSION_TOO_OLD', `${label}: the codeless 409 folds as the gate`);
  }
});

test('a text() resolving to a non-string under a 502 retries like the string twin, then folds the exhaustion', async () => {
  const savedSeam = process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
  process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '0,0';
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    calls += 1;
    return { status: 502, ok: false, text: async () => ({ deep: true }) };
  }) as unknown as typeof global.fetch;
  try {
    const outcome = await hdkitConnectWithRetry({}).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(outcome, 'expected rejection');
    assert.equal(calls, 3, 'the hostile body under 502 retries exactly like the string twin (1 + 2 retries)');
    const err = outcome as Error & { gatewayRetryExhausted?: boolean };
    assert.ok(!(err instanceof TypeError), 'never a raw TypeError');
    assert.equal(err.gatewayRetryExhausted, true, 'the exhaustion decoration rides');
    const fold = transientExhaustionResult(err);
    assert.equal(fold?.ok, false, 'the exhaustion fold fires on the decorated carrier');
    assert.equal(fold?.code, 'HDKIT_GATEWAY_TIMEOUT');
  } finally {
    global.fetch = originalFetch;
    if (savedSeam === undefined) delete process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
    else process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = savedSeam;
  }
});

test('a non-finite status manufactures nothing: NaN and Infinity never become HTTP_x', async () => {
  for (const status of [Number.NaN, Number.POSITIVE_INFINITY] as const) {
    const err = (await rejectViaHostileResponse({
      status,
      ok: false,
      text: async () => JSON.stringify({ message: 'gateway busy' }),
    })) as Error & { code?: unknown; status?: unknown };
    assert.ok(!(err instanceof TypeError));
    assert.equal(err.code, undefined, `status ${String(status)}: no HTTP_ manufactured code`);
    assert.match(err.message, /gateway busy/, `status ${String(status)}: the message carries`);
    assert.equal(err.status, undefined, `status ${String(status)}: a non-finite status does not attach`);
  }
});

// ── 体读取的有界化与状态细则（round 19）──
// fetch 的 abort 定时器在其 finally 里、体读取之前清除——永不结算的 text()
// 无模块侧上界（自转 thenable 连微任务队列都饿死，任何定时器都排不上——
// 记录边界）。第二个定时器在同一 controller 上跨体读取持续武装：非结算体
// 落进设计 transportReason 包装。状态细则：-1/-0/502.5 是有限数但非法——
// 与 NaN 同路（无伪造码、不携带）。

test('a never-settling body lands in the designed wrap within the module bound — the call never hangs', async () => {
  const realSetTimeout = setTimeout;
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    status: 409,
    ok: false,
    text: (): Promise<string> => new Promise<string>(() => {}),
  })) as unknown as typeof global.fetch;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = hdkitConnectWithRetry({}).then(
      () => 'settled-ok',
      (error: unknown) => error,
    );
    // 真定时器看门狗（在 mock 启用前捕获）：未修复时 3 秒后判 UNBOUNDED——
    // 红阶段不悬挂测试
    const watchdog = new Promise<string>((resolve) => {
      realSetTimeout(() => resolve('UNBOUNDED'), 3000);
    });
    // 先让流程推进到体读取（fetch 桩的微任务链 drain 到 bodyTimer 的创建）
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(300000);
    const outcome = await Promise.race([pending, watchdog]);
    assert.notEqual(outcome, 'UNBOUNDED', 'the body await is bounded — the module-side timer settles the read');
    const err = outcome as Error & { bodyUnreadable?: boolean; status?: unknown };
    assert.ok(!(err instanceof TypeError));
    assert.equal(err.bodyUnreadable, true, 'the wrap marker rides');
    assert.equal(err.status, 409, 'the honest status attaches');
    const gate = versionGateResult(err);
    assert.equal(gate?.code, 'HDKIT_VERSION_TOO_OLD', 'the wrap folds as the codeless gate');
  } finally {
    mock.timers.reset();
    global.fetch = originalFetch;
  }
});

test('the status letter: -1, -0, and 502.5 behave like the NaN twin — no HTTP_x, no attach, no retry', async () => {
  for (const status of [-1, -0, 502.5] as const) {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      calls += 1;
      return {
        status,
        ok: false,
        text: async () => JSON.stringify({ message: 'gateway busy' }),
      };
    }) as unknown as typeof global.fetch;
    try {
      const outcome = await hdkitConnectWithRetry({}).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(outcome, `status ${String(status)}: expected rejection`);
      const err = outcome as Error & { code?: unknown; status?: unknown };
      assert.ok(!(err instanceof TypeError));
      assert.equal(err.code, undefined, `status ${String(status)}: no HTTP_x manufactured code`);
      assert.equal(err.status, undefined, `status ${String(status)}: an out-of-range integer does not attach`);
      assert.match(err.message, /gateway busy/, `status ${String(status)}: the message carries`);
      assert.equal(calls, 1, `status ${String(status)}: never transient — a single fetch`);
    } finally {
      global.fetch = originalFetch;
    }
  }
});
