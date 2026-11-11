import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

// 源树派生路径（round 5）：structure-helpers 的 pluginRoot 在模块加载时断言
// 生成 skills 树，单文件 node --test 在未构建检出上会死于该断言；这里只读
// src 下的模块文本，无需生成树。
const pluginSourceRoot = fileURLToPath(new URL('../plugins/huaweicloud-core', import.meta.url));

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
process.env.HW_IAM_ENDPOINT = 'https://iam.example.test';
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
// 池缓存落盘路径隔离（fixtureDir 注册，进程退出回收）
process.env.HW_SANDBOX_POOL_CACHE_PATH = join(fixtureDir('hdkit-gate-retry'), 'sandbox-pools.json');
delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
delete process.env.HW_POOL_TEMPLATE_PERSISTENT;

// 409 版本门禁 + 502/504 连接重试（dev e0c8700b + 501fd8b4 + e1255a4b 移植）：
// API 层重试语义与 callTool 层各出口的结构化门禁折叠。
const restoreFetchEnv = isolateDirectFetchEnv();
after(() => {
  restoreFetchEnv();
});

const { hdkitConnectWithRetry } = await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts');
const {
  connectRetryDelaysMs,
  decorateExhaustedConnect,
  isNonRetryableBusinessError,
  rendersBlank,
  cleanMessage,
  versionGateMessage,
  versionGateResult,
  transientExhaustionResult,
} = await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkit-gate.ts');
const { callTool } = await import('../plugins/huaweicloud-core/src/tools.ts');

const VENDOR = 'test: vendor established by the harness';

const VERSION_GATE_409 = {
  code: 'HDKIT_VERSION_TOO_OLD',
  message: '插件版本过旧，请升级至正式版 2.0.0 及以上。',
  clientVersion: '2.0.0-next.0',
  minVersion: '2.0.0',
};

function htmlPage(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

function jsonEnvelope(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function stubConnectSequence(responses: Array<() => Response>): { restore: () => void; calls: () => number } {
  const originalFetch = global.fetch;
  let n = 0;
  global.fetch = async () => {
    const make = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return make();
  };
  return {
    restore: () => {
      global.fetch = originalFetch;
    },
    calls: () => n,
  };
}

function stubRouted(routes: Array<{ url: string; respond: () => Response }>): () => void {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const text = String(url);
    for (const route of routes) {
      if (text.includes(route.url)) return route.respond();
    }
    return jsonEnvelope({ code: 'HDKIT_INTERNAL', message: `unrouted url: ${text}` }, { status: 500 });
  };
  return () => {
    global.fetch = originalFetch;
  };
}

function withRetrySeam(value: string): () => void {
  const saved = process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
  process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = value;
  return () => {
    if (saved === undefined) delete process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
    else process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = saved;
  };
}

async function captureConnectRejection(options: Record<string, unknown>): Promise<ExhaustedResult & Error> {
  const outcome = await hdkitConnectWithRetry(options).then(
    () => null,
    (error) => error,
  );
  assert.ok(outcome, 'expected rejection');
  return outcome as ExhaustedResult & Error;
}

// 中断响应的 fetch 桩安装（round 6 去重）：七个 codeless-409/中断用例共用
function installAbortingFetch(status: number, reason: unknown): { restore: () => void; calls: () => number } {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return abortingBodyWith(status, reason);
  };
  return {
    restore: () => {
      global.fetch = originalFetch;
    },
    calls: () => calls,
  };
}

// 中断响应的捕获共用（round 6 去重）：装 fetch 桩→捕获拒绝→还原
async function captureAbortRejection(
  status: number,
  reason: unknown,
): Promise<{ err: ExhaustedResult & Error; calls: number }> {
  const fetch = installAbortingFetch(status, reason);
  try {
    const err = await captureConnectRejection({});
    return { err, calls: fetch.calls() };
  } finally {
    fetch.restore();
  }
}

// voucher_status 出口调用共用（round 6 去重）：装桩→调用→还原
async function voucherStatusUnder(respond: () => Response): Promise<GateResult & { claimed?: boolean }> {
  const stub = stubConnectSequence([respond]);
  try {
    return (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
  } finally {
    stub.restore();
  }
}

// connect 出口调用共用（round 8 去重）：重试表针脚 + 桩 + 调用 + 还原
async function connectUnder(respond: () => Response, seam: string): Promise<ExhaustedResult> {
  const restoreSeam = withRetrySeam(seam);
  const stub = stubConnectSequence([respond]);
  try {
    return (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ExhaustedResult;
  } finally {
    stub.restore();
    restoreSeam();
  }
}

interface GateResult {
  ok?: boolean;
  code?: string;
  message?: string;
  clientVersion?: string;
  minVersion?: string;
  remediation?: { hint: string; steps: string[] };
}

interface ExhaustedResult extends GateResult {
  connectRetries?: number;
  status?: number;
  retryAfter?: string;
}

function assertGatePayload(result: GateResult): void {
  assert.equal(result.clientVersion, '2.0.0-next.0');
  assert.equal(result.minVersion, '2.0.0');
  assert.ok(result.remediation, 'remediation must survive the MCP boundary');
  assert.match(result.remediation!.hint, /版本过旧/);
  assert.match(result.remediation!.hint, /2\.0\.0/);
  assert.match(result.remediation!.steps.join(' '), /huaweicloud-devkit@latest update --target <agent>/);
  assert.match(result.remediation!.steps.join(' '), /重启/);
  assert.match(result.remediation!.steps.join(' '), /huaweicloud_upgrade/);
}

function assertGateFold(result: GateResult): void {
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
  assertGatePayload(result);
}

// ── 重试表与 env 针脚（HW_SANDBOX_CONNECT_RETRY_DELAYS_MS，v2 扩展）──

test('connectRetryDelaysMs parses the env seam and falls back to the dev table on malformed input', () => {
  const saved = process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
  try {
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '1,2';
    assert.deepEqual(connectRetryDelaysMs(), [1, 2]);
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '0';
    assert.deepEqual(connectRetryDelaysMs(), [0]);
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '5, 7';
    assert.deepEqual(connectRetryDelaysMs(), [5, 7], 'whitespace inside a valid entry trims fine');
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = 'bogus';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000]);
    delete process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000]);
    // 空条目非法（Number('') === 0 的陷阱：空白条目会变成零延迟重试档）
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '5,,7';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000], 'a blank entry falls back wholesale');
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = ',';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000], 'a lone comma is illegal');
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '5,7,';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000], 'a trailing comma adds no zero-delay retry');
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = ' , ';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000], 'whitespace-only entries are illegal');
  } finally {
    if (saved === undefined) delete process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
    else process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = saved;
  }
});

// ── API 层：hdkitConnectWithRetry（dev e0c8700b）──

test('hdkitConnectWithRetry retries gateway 502/504 then succeeds, surfacing connect_retries', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([
    () => htmlPage(502, '<html>502 Bad Gateway</html>'),
    () => htmlPage(504, '<html>504 Gateway Time-out</html>'),
    () => jsonEnvelope({ session_id: 's1', dev_stage_id: 'd1', pool_type: 'ephemeral' }),
  ]);
  const start = Date.now();
  try {
    const result = (await hdkitConnectWithRetry({ pool_type: 'ephemeral' })) as Record<string, unknown> & {
      connect_retries?: number;
    };
    const elapsed = Date.now() - start;
    assert.equal(result.session_id, 's1');
    assert.equal(result.connect_retries, 2, 'a successful retry must surface the count (v2 extension)');
    assert.equal(stub.calls(), 3);
    assert.ok(elapsed >= 10, `expected the two 5ms backoff steps to run, took ${elapsed}ms`);
    assert.ok(elapsed < 250, `retry path must stay under the table ceiling, took ${elapsed}ms`);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('hdkitConnectWithRetry exhausts the table and reports the attempt count with transient remediation', async () => {
  const restoreSeam = withRetrySeam('5');
  const stub = stubConnectSequence([() => htmlPage(504, '<html>504 Gateway Time-out</html>')]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.connectRetries, 1, 'the error path surfaces the attempt count (dev parity)');
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
    assert.equal(err.code, 'HDKIT_GATEWAY_TIMEOUT');
    assert.match(err.message, /504/);
    assert.ok(err.remediation, 'exhaustion remediation must exist');
    assert.match(err.remediation!.hint, /网关/);
    assert.match(err.remediation!.hint, /重试 1 次/);
    assert.match(err.remediation!.steps.join(' '), /复用/);
    assert.equal(stub.calls(), 2, 'one table delay means exactly two calls');
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('connect does not retry non-gateway statuses: HTTP 500 fails on the first attempt', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([
    () => jsonEnvelope({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }, { status: 500 }),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.code, 'HDKIT_INTERNAL');
    assert.equal(err.connectRetries, 0);
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('connect never retries the 409 version gate (non-retryable verdict)', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 409 })]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(err.status, 409);
    assert.equal(err.clientVersion, '2.0.0-next.0');
    assert.equal(err.minVersion, '2.0.0');
    assert.ok(err.remediation, 'the gate remediation must be on the error');
    assert.match(err.remediation!.steps.join(' '), /huaweicloud-devkit@latest update --target <agent>/);
    assert.equal(err.connectRetries, 0);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('exhaustion keeps a business-coded 502 remediation (burn-core) and never overwrites it', async () => {
  const restoreSeam = withRetrySeam('5');
  const stub = stubConnectSequence([
    () =>
      jsonEnvelope(
        {
          code: 'HDKIT_UPSTREAM_ERROR',
          message:
            '沙箱编排上游调用失败: GET /open-api-public/v2/devenvs upstream error HD.97520422: The remaining core hours has been used up',
        },
        { status: 502 },
      ),
  ]);
  try {
    const err = (await captureConnectRejection({})) as ExhaustedResult & { coreHoursExhausted?: boolean } & Error;
    assert.equal(err.code, 'HDKIT_UPSTREAM_ERROR', 'a business-coded 502 keeps its own code');
    assert.equal(err.coreHoursExhausted, true);
    assert.ok(err.remediation);
    assert.match(err.remediation!.hint, /核心时长/, 'the burn-core remediation must win over the transient copy');
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
    assert.equal(err.connectRetries, 1);
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

// ── callTool 层：409 门禁按出口折叠（dev 501fd8b4 + e1255a4b）──

test('callTool connect: 409 version gate returns ok:false with upgrade remediation', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 409 })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as GateResult;
    assertGateFold(result);
    assert.equal((result as ExhaustedResult).connectRetries, undefined, 'the gate fold is not the exhaustion path');
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('callTool check_user: 409 version gate returns structured guidance instead of a bare throw', async () => {
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 409 })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assertGateFold(result);
  } finally {
    stub.restore();
  }
});

test('callTool sign_agreement: 409 version gate returns structured guidance', async () => {
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 409 })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_sign_agreement', {})) as GateResult;
    assertGateFold(result);
  } finally {
    stub.restore();
  }
});

test('callTool credentials: 409 version gate returns structured guidance after IAM validation passes', async () => {
  const restore = stubRouted([
    { url: 'iam.example.test', respond: () => jsonEnvelope({ projects: [{ id: 'p-1' }] }) },
    { url: 'hdkitservice', respond: () => jsonEnvelope(VERSION_GATE_409, { status: 409 }) },
  ]);
  try {
    const result = (await callTool('huaweicloud_sandbox_credentials', {
      dev_stage_id: 'd-1',
    })) as GateResult;
    assertGateFold(result);
  } finally {
    restore();
  }
});

test('callTool voucher_status: 409 version gate passes clientVersion/minVersion through the fallback', async () => {
  const result = await voucherStatusUnder(() => jsonEnvelope(VERSION_GATE_409, { status: 409 }));
  // voucher 三出口保持 claimed:false 信封（dev e1255a4b voucherErrorResult 语义），
  // 门禁字段附加其上而非 ok:false 形态
  assert.equal(result.claimed, false);
  assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
  assertGatePayload(result);
});

// ── callTool 层：瞬时耗尽的结构化折叠（v2 扩展；dev 在此路径裸抛）──

test('callTool connect: gateway 502 exhaustion returns ok:false with the attempt count and transient remediation', async () => {
  const result = await connectUnder(() => htmlPage(502, '<html>502 Bad Gateway</html>'), '5');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.equal(result.connectRetries, 1);
  assert.ok(result.remediation);
  assert.match(result.remediation!.hint, /网关/);
  assert.match(result.remediation!.hint, /重试 1 次/);
});

// ── 非 JSON 路径与状态改写网关（round 3）──
// 非 JSON 抛错必须携带 resp.status（Object.assign）：否则一个 500/200/401 的
// 非 JSON 页只要前 200 字符里带 "Bad Gateway" 就会骗过消息兜底，重试满表并
// 误报成网关超时。消息兜底随之死亡（所有 hdkit 错误都带 status）并删除。

test('a non-JSON 500 page carrying Bad Gateway text costs one fetch and never folds as transient', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([
    () => htmlPage(500, '<html><head><title>502 Bad Gateway</title></head><body>upstream error page</body></html>'),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(stub.calls(), 1, 'a non-JSON 500 must not be retried');
    assert.equal(err.status, 500, 'the non-JSON throw must carry its status');
    assert.equal(err.code, undefined);
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    assert.equal(err.remediation, undefined, 'no transient remediation copy on a 500');
    assert.equal(err.connectRetries, 0);
    await assert.rejects(
      callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'ephemeral' }),
      /non-JSON \(status 500\)/,
    );
    assert.equal(stub.calls(), 2, 'the callTool-level attempt was also a single fetch');
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('non-JSON 200 and 401 pages carrying gateway words do not retry', async () => {
  const restoreSeam = withRetrySeam('5,5');
  for (const status of [200, 401] as const) {
    const stub = stubConnectSequence([() => htmlPage(status, '<html>Bad Gateway error template</html>')]);
    try {
      const err = await captureConnectRejection({});
      assert.equal(stub.calls(), 1, `a non-JSON ${status} page must not be retried`);
      assert.equal(err.status, status);
      assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    } finally {
      stub.restore();
    }
  }
  restoreSeam();
});

test('a non-JSON 502 page still retries and surfaces the count', async () => {
  const restoreSeam = withRetrySeam('5');
  const stub = stubConnectSequence([
    () => htmlPage(502, '<html>gateway timeout page, no keywords in text</html>'),
    () => jsonEnvelope({ session_id: 's1', dev_stage_id: 'd1', pool_type: 'ephemeral' }),
  ]);
  try {
    const result = (await hdkitConnectWithRetry({ pool_type: 'ephemeral' })) as Record<string, unknown>;
    assert.equal(result.session_id, 's1');
    assert.equal(result.connect_retries, 1);
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

// ── 客户端裁决码不被重试（round 3）：状态改写网关把业务信封套在 502/504 下 ──
// 门禁/配额/容量/凭证四类是"客户端裁决"——其 remediation 指向调用方要做的动作
// （升级/释放/错峰/修凭证），有界即时重试无法推进；上游错误码（如烧核
// HDKIT_UPSTREAM_ERROR）跟随 status（dev 同款）。

test('a gate payload arriving under a 502 status is not retried against its own permanent verdict', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 502 })]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(stub.calls(), 1, 'the gate must not be retried even under a 502 status');
    assert.equal(err.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(err.status, 502);
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    assert.equal(err.connectRetries, 0);
    assert.ok(err.remediation);
    assert.match(err.remediation!.hint, /版本过旧/);
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as GateResult;
    assertGateFold(result);
    assert.equal(stub.calls(), 2, 'the callTool-level attempt was also a single fetch');
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('quota-class client-verdict payloads under a 502 status are never retried', async () => {
  const restoreSeam = withRetrySeam('5,5');
  for (const code of ['HDKIT_QUOTA_EXCEEDED', 'HDKIT_CAPACITY_INSUFFICIENT', 'HDKIT_CRED_INVALID'] as const) {
    const stub = stubConnectSequence([() => jsonEnvelope({ code, message: '沙箱并发配额已满' }, { status: 502 })]);
    try {
      const err = await captureConnectRejection({});
      assert.equal(stub.calls(), 1, `${code} must not be retried even under a 502 status`);
      assert.equal(err.code, code);
      assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
      assert.equal(err.connectRetries, 0);
    } finally {
      stub.restore();
    }
  }
  restoreSeam();
});

// ── 中断原因字面量与不可见字符（round 5）──
// fetch 的 text() 可能以 undefined / null / 字符串 / Error 拒绝：非 Error 原因
// 不得落 String(error) 字面量（asText 同款陷阱）；零宽空格等 Cf 类字符
// trim 不清除，渲染为"看起来空白"的消息必须走设计好的兜底。

function abortingBodyWith(status: number, reason: unknown): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => {
      throw reason;
    },
  } as unknown as Response;
}

test('abort reasons never surface as literals: undefined, null, string, Error each render real text', async () => {
  const restoreSeam = withRetrySeam('5,5');
  try {
    for (const [reason, expectFragment] of [
      [undefined, /body read aborted/],
      [null, /body read aborted/],
      ['raw string reason', /raw string reason/],
      [new TypeError('terminated'), /terminated/],
    ] as const) {
      const { err, calls } = await captureAbortRejection(500, reason);
      assert.equal(calls, 1, 'a 500 answer, aborted or not, is not transient');
      assert.equal(err.status, 500);
      assert.match(err.message, expectFragment, `the ${String(reason)} reason must surface real text`);
      assert.doesNotMatch(err.message, /^undefined$|^null$/);
    }
  } finally {
    restoreSeam();
  }
});

test('an aborted 502 body rejected with undefined still retries and surfaces a real exhaustion message', async () => {
  const restoreSeam = withRetrySeam('5');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return abortingBodyWith(502, undefined);
  };
  try {
    const err = await captureConnectRejection({});
    assert.equal(calls, 2, 'the aborted 502 body is transient regardless of the reason');
    assert.equal(err.status, 502);
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
    assert.equal(err.code, 'HDKIT_GATEWAY_TIMEOUT');
    assert.match(err.message, /body read aborted/, 'the wrap builds a real message for a falsy reason');
    assert.doesNotMatch(err.message, /^undefined$|^null$/);
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

test('a zero-width-space gate message renders the designed fallback on the connect exit', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: '​' })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_sign_agreement', {})) as GateResult;
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    // 构建口把 U+200B 视同缺失 → 请求层兜底；round 6 起 applyVersionGate 不再
    // 用不可见消息覆盖好的构建文案——出口渲染真实文本，绝不视觉空白
    assert.match(
      result.message ?? '',
      /HDKIT_VERSION_TOO_OLD: hdkitservice error|插件版本过旧/,
      'real copy fires for U+200B',
    );
    assert.ok(!rendersBlank(result.message ?? ''), 'no visually blank message');
  } finally {
    stub.restore();
  }
});

test('an aborted codeless 409 body folds as the gate with the unknown-version fallbacks', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const fetch = installAbortingFetch(409, new TypeError('terminated'));
  try {
    const err = await captureConnectRejection({});
    assert.equal(fetch.calls(), 1, 'the gate is never retried, codeless or not');
    assert.equal(err.status, 409);
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.match(result.message ?? '', /插件版本过旧/);
    assert.match(result.remediation!.hint, /当前 未知/);
    assert.match(result.remediation!.hint, /最新版/);
    assert.equal('clientVersion' in (result as Record<string, unknown>), false);
    assertNoLeakyLiterals(result);
  } finally {
    fetch.restore();
    restoreSeam();
  }
});

// ── 空白消息在构建口收窄（round 4）：出口逐个钉 ──
// 构建口只有两处读 rec.message：请求层消息构建与容量分支。空白即缺失，
// 设计好的兜底（'hdkitservice error' / 代码前缀构建 / 门禁文案）在各出口生效。

test('gate exit: a whitespace-only 409 message renders the designed fallback, never blank', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: '   \t\n ' })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.match(result.message ?? '', /hdkitservice error/, 'the request-layer designed fallback must fire');
    assert.doesNotMatch(result.message ?? '', /\s+$/, 'no blank tail on the surfaced copy');
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

test('capacity exit: a whitespace-only 429 message keeps the code-prefixed fallback, never blank', async () => {
  const result = await connectUnder(
    () =>
      jsonEnvelope(
        { code: 'HDKIT_CAPACITY_INSUFFICIENT', message: '   ' },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    '5,5',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_CAPACITY_INSUFFICIENT');
  assert.match(result.message ?? '', /HDKIT_CAPACITY_INSUFFICIENT/, 'the code-prefixed build must survive');
  assert.doesNotMatch(result.message ?? '', /^\s+|\s+$/, 'no pure-blank message field');
});

test('voucher exit: a whitespace-only gate message never renders blank', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: ' \n\t ' })]);
  try {
    const result = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
    assert.equal(result.claimed, false);
    assert.match(result.message ?? '', /HDKIT_VERSION_TOO_OLD/, 'the code-prefixed build must survive');
    assert.doesNotMatch(result.message ?? '', /^\s*$|\s+$/, 'no blank message on the voucher fallback');
  } finally {
    stub.restore();
  }
});

test('the deleted message-form fallback stays deleted (structure pin on the gate module)', () => {
  const source = readFileSync(join(pluginSourceRoot, 'src', 'lib', 'hdkit', 'hdkit-gate.ts'), 'utf8');
  assert.doesNotMatch(source, /Gateway Time-out|Bad Gateway/, 'the message-form fallback must not return');
  assert.doesNotMatch(source, /non-JSON \\\(status/, 'the non-JSON message sniff must not return');
  assert.match(source, /TRANSIENT_STATUSES\.has\(err\.status\)/, 'the verdict stays keyed on the returned status');
});

// ── 账号校验裁决码不参与重试（round 4）──
// SKILL 的 connect 契约把 HDKIT_NOT_REALNAME / _NOT_AGREEMENT /
// _NOT_REALNAME_AND_AGREEMENT 教成"告知开发者一次即停"的裁决——与配额同类
// 的调用方动作码；状态改写网关把它们套在 502/504 下送达时，满表重试后盖上
// 瞬时网关 remediation 是相反的指引。

test('account-verification verdicts under rewritten 502/504 statuses cost one fetch and keep their own envelope', async () => {
  const restoreSeam = withRetrySeam('5,5');
  try {
    for (const status of [502, 504] as const) {
      for (const code of ['HDKIT_NOT_REALNAME', 'HDKIT_NOT_AGREEMENT', 'HDKIT_NOT_REALNAME_AND_AGREEMENT'] as const) {
        const stub = stubConnectSequence([
          () => jsonEnvelope({ code, message: 'realname and agreement required' }, { status }),
        ]);
        try {
          const err = await captureConnectRejection({});
          assert.equal(stub.calls(), 1, `${code} under ${status} must not be retried`);
          assert.equal(err.code, code, 'the verdict keeps its own code');
          assert.equal(err.status, status);
          assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
          assert.equal(err.remediation, undefined, 'no transient copy may decorate it');
          await assert.rejects(
            callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'ephemeral' }),
            (error: ExhaustedResult & Error) => error.code === code,
            `${code} must keep its own thrown envelope at the tool exit`,
          );
          assert.equal(stub.calls(), 2, 'the callTool-level attempt was also a single fetch');
        } finally {
          stub.restore();
        }
      }
    }
  } finally {
    restoreSeam();
  }
});

// ── 响应体读取中断携带 status（round 4，v2 标注分歧）──
// dev 对 body 读取中断裸抛（无 status）；v2 用与 non-JSON 抛错同款的
// Object.assign 携带 resp.status——重试契约在已收到 status 时照常适用。

function abortingBody(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => {
      throw new TypeError('terminated');
    },
  } as unknown as Response;
}

test('a body-read abort on a 502 status is retried and the count surfaces', async () => {
  const restoreSeam = withRetrySeam('5');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? abortingBody(502)
      : jsonEnvelope({ session_id: 's1', dev_stage_id: 'd1', pool_type: 'ephemeral' });
  };
  try {
    const result = (await hdkitConnectWithRetry({ pool_type: 'ephemeral' })) as Record<string, unknown>;
    assert.equal(result.session_id, 's1');
    assert.equal(result.connect_retries, 1, 'the aborted 502 body is a transient answer and retries');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

test('a body-read abort on a 500 status costs one fetch and carries its status', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return abortingBody(500);
  };
  try {
    const err = await captureConnectRejection({});
    assert.equal(calls, 1, 'a 500 answer, aborted or not, is not transient');
    assert.equal(err.status, 500, 'the aborted body read must carry its status');
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    assert.equal(err.connectRetries, 0);
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

// ── 窄化反模式清理（round 3）：容量分支同款 asText 陷阱 ──

test('a message-less capacity payload keeps the code-prefixed fallback, never the literal', async () => {
  const stub = stubConnectSequence([
    () => jsonEnvelope({ code: 'HDKIT_CAPACITY_INSUFFICIENT' }, { status: 429, headers: { 'Retry-After': '60' } }),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.code, 'HDKIT_CAPACITY_INSUFFICIENT');
    assert.match(err.message, /HDKIT_CAPACITY_INSUFFICIENT/, 'the message keeps the code-prefixed fallback');
    assert.doesNotMatch(err.message, /undefined|null/);
  } finally {
    stub.restore();
  }
});

test('whitespace-only gate field values trim to the designed fallbacks', async () => {
  const stub = stubConnectSequence([
    () => gateJson({ message: '插件版本过旧。', clientVersion: '   ', minVersion: '\t ' }),
  ]);
  try {
    const err = (await captureConnectRejection({})) as ExhaustedResult & Error;
    assert.equal(err.clientVersion, undefined, 'a whitespace-only version narrows away');
    assert.equal(err.minVersion, undefined);
    assert.match(err.remediation!.hint, /当前 未知/);
    assert.match(err.remediation!.hint, /最新版/);
    assertNoLeakyLiterals({ hint: err.remediation!.hint });
  } finally {
    stub.restore();
  }
});
// ── 部分载荷门禁（409 只带部分字段）：设计好的兜底必须真正生效 ──
// 窄化规则：asText(undefined) === 'undefined'（真值），asText(rec.x) || undefined
// 永不回退——hdkitservice 边界读取必须用 asString 窄化，否则字面量 "undefined"
// 会流进用户可见文案（移植引入缺陷，dev 501fd8b4 直传原始值）。

function gateJson(payload: Record<string, unknown>): Response {
  return jsonEnvelope({ code: 'HDKIT_VERSION_TOO_OLD', ...payload }, { status: 409 });
}

function assertNoLeakyLiterals(result: unknown): void {
  const serialized = JSON.stringify(result);
  assert.ok(!serialized!.includes('undefined'), `no literal "undefined" in the surfaced copy: ${serialized}`);
  assert.ok(!serialized!.includes('null'), `no literal "null" in the surfaced copy: ${serialized}`);
}

test('version gate with absent versions falls back to the designed 未知/最新版 copy', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: '插件版本过旧，请升级至正式版 2.0.0 及以上。' })]);
  try {
    const err = (await captureConnectRejection({})) as ExhaustedResult & Error;
    assert.equal(err.clientVersion, undefined);
    assert.equal(err.minVersion, undefined);
    assert.match(err.remediation!.hint, /当前 未知/);
    assert.match(err.remediation!.hint, /最新版/);
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as Record<string, unknown>;
    assert.equal('clientVersion' in result, false);
    assert.equal('minVersion' in result, false);
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

test('version gate with minVersion only missing keeps clientVersion and the fallback floor', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: '插件版本过旧。', clientVersion: '2.0.0-next.0' })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_sign_agreement', {})) as GateResult;
    assert.equal(result.clientVersion, '2.0.0-next.0');
    assert.equal('minVersion' in (result as Record<string, unknown>), false);
    assert.match(result.remediation!.hint, /最新版/);
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

test('version gate with message only missing keeps the code-prefixed error message', async () => {
  const stub = stubConnectSequence([() => gateJson({ clientVersion: '2.0.0-next.0', minVersion: '2.0.0' })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.match(result.message ?? '', /HDKIT_VERSION_TOO_OLD/);
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

test('version gate with null-valued fields narrows to the designed fallbacks', async () => {
  const stub = stubConnectSequence([() => gateJson({ message: null, clientVersion: null, minVersion: null })]);
  try {
    const result = (await callTool('huaweicloud_voucher_status', {})) as GateResult;
    assert.match(result.remediation!.hint, /当前 未知/);
    assert.match(result.remediation!.hint, /最新版/);
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

// ── 瞬时判定：有 status 时只认 502/504（v2 标注分歧，dev 的消息正则无条件生效）──

test('a 500 business error carrying Bad Gateway text is not transient', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([
    () =>
      jsonEnvelope(
        {
          code: 'HDKIT_UPSTREAM_ERROR',
          message: '沙箱编排上游调用失败: GET /open-api-public/v2/devenvs failed: Bad Gateway',
        },
        { status: 500 },
      ),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(stub.calls(), 1, 'a status-500 error must not be retried');
    assert.equal(err.code, 'HDKIT_UPSTREAM_ERROR');
    assert.equal(err.connectRetries, 0);
    assert.equal((err as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
    assert.equal(err.remediation, undefined, 'no transient remediation copy on a non-gateway status');
    // callTool 层：非门禁/非耗尽/非业务折叠的错误按原样抛出（MCP 信封只带
    // code+message）——不允许折叠成带 connectRetries/网关 remediation 的结果
    await assert.rejects(
      callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'ephemeral' }),
      (error: ExhaustedResult & Error) => {
        assert.equal(error.code, 'HDKIT_UPSTREAM_ERROR');
        assert.equal((error as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, undefined);
        assert.equal(error.remediation, undefined);
        return true;
      },
    );
    assert.equal(stub.calls(), 2, 'the callTool-level attempt was also a single fetch');
  } finally {
    stub.restore();
    restoreSeam();
  }
});

// ── Cf 类完整收口与纯不可见语义（round 6）──
// 声明的 8 码点全部生效；Cf 一般类别整体判定（\p{Cf}）外加渲染为空白的
// 非 Cf 填充符；纯不可见才判空白——真文本包着一个不可见字符是可见消息。

// 单码点空白断言（round 6/7 共用）：rendersBlank 判空白 + cleanMessage 归缺失
function assertBlankCodepoint(ch: string): void {
  const label = `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;
  assert.equal(rendersBlank(ch), true, `${label} must render blank`);
  assert.equal(cleanMessage(ch), '', `${label} must clean to absent`);
}

test('rendersBlank matches the Cf class: every declared and newly-covered codepoint is blank, mixed text is not', () => {
  const blankChars = [
    '\u200b',
    '\u200c',
    '\u200d',
    '\u200e',
    '\u200f',
    '\u2060',
    '\u3164',
    '\u2800',
    '\u00ad',
    '\u061c',
    '\u180e',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2061',
    '\u2062',
    '\u2063',
    '\u2064',
    '\ufeff',
    '\u115f',
    '\u1160',
    '\u{e0061}',
  ];
  for (const ch of blankChars) {
    assertBlankCodepoint(ch);
  }
  assert.equal(rendersBlank('插件\u200b版本'), false, 'real text around an invisible char is not blank');
  assert.equal(cleanMessage(' 插件\u200b版本 '), '插件\u200b版本', 'mixed text surfaces trimmed, never dropped');
});

test('Cf-class gate messages render the designed copy, never an invisible payload', async () => {
  for (const ch of [
    '\u200c',
    '\u200d',
    '\u200e',
    '\u200f',
    '\u00ad',
    '\u061c',
    '\u180e',
    '\u202e',
    '󠄀',
    '᠋',
    '឴',
    '\uFFF9',
    '\u{13430}',
  ]) {
    const stub = stubConnectSequence([() => gateJson({ message: ch })]);
    try {
      const result = (await callTool('huaweicloud_sandbox_sign_agreement', {})) as GateResult;
      assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
      assert.match(result.message ?? '', /hdkitservice error|插件版本过旧/, 'real text must surface');
      assert.ok(!rendersBlank(result.message ?? ''), 'never a visually blank message');
    } finally {
      stub.restore();
    }
  }
});

test('invisible clientVersion and minVersion narrow away; the hint falls to the designed slots', async () => {
  const stub = stubConnectSequence([
    () => gateJson({ message: '插件版本过旧。', clientVersion: '\u200b', minVersion: '\u200d' }),
  ]);
  try {
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal('clientVersion' in (result as Record<string, unknown>), false);
    assert.equal('minVersion' in (result as Record<string, unknown>), false);
    assert.match(result.remediation!.hint, /当前 未知/);
    assert.match(result.remediation!.hint, /最新版/);
    assertNoLeakyLiterals(result);
  } finally {
    stub.restore();
  }
});

test('an invisible or blank abort reason surfaces real text on the wrap, on folding and non-folding statuses', async () => {
  const restoreSeam = withRetrySeam('1');
  try {
    for (const reason of ['\u200c', new Error('   '), new Error('\u00ad')] as const) {
      const { err, calls } = await captureAbortRejection(500, reason);
      assert.equal(calls, 1, 'a 500 answer is never transient, whatever the reason');
      assert.equal(err.status, 500);
      assert.match(err.message, /body read aborted/, 'a blank reason falls to the designed wrap copy');
      assert.ok(!rendersBlank(err.message), 'never a visually blank wrap message');
    }
  } finally {
    restoreSeam();
  }
});

test('a blank Error abort reason on a 502 exhaustion surfaces real text, never the invisible reason', async () => {
  const restoreSeam = withRetrySeam('1');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return abortingBodyWith(502, new Error('\u200c'));
  };
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ExhaustedResult;
    assert.equal(calls, 2, 'the 502 retries then exhausts');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT', 'the exhaustion fold fires');
    assert.ok(!rendersBlank(String(result.message ?? '')), 'the exhaustion exit never renders blank');
    assert.ok(String(result.message ?? '').length > 0, 'the cleaned reason or the designed copy fires');
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

// ── 可读无码 409（round 6）：请求层不再为 409 伪造 HTTP_409 码 ──

test('the request layer no longer manufactures a code for a codeless 409', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const stub = stubConnectSequence([
    () => jsonEnvelope({ message: '插件版本过旧，请升级至正式版 2.0.0 及以上。' }, { status: 409 }),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(stub.calls(), 1, 'a 409 is never retried, codeless or not');
    assert.equal(err.code, undefined, 'a codeless 409 must not carry a manufactured HTTP_409');
    assert.equal(err.status, 409);
    assert.match(
      err.message ?? '',
      /插件版本过旧，请升级至正式版 2\.0\.0 及以上/,
      'the server copy survives unprefixed',
    );
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('a readable codeless 409 folds as the gate on the sandbox and voucher exits with the server copy', async () => {
  const stub = stubConnectSequence([
    () => jsonEnvelope({ message: '插件版本过旧，请升级至正式版 2.0.0 及以上。' }, { status: 409 }),
  ]);
  try {
    const cu = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(cu.ok, false);
    assert.equal(cu.code, 'HDKIT_VERSION_TOO_OLD');
    assert.match(
      cu.message ?? '',
      /插件版本过旧，请升级至正式版 2\.0\.0 及以上/,
      'the readable shape surfaces the server copy',
    );
    assert.ok(cu.remediation, 'the unknown-version remediation mints');
    assert.match(cu.remediation!.hint, /当前 未知/);
    assert.match(cu.remediation!.hint, /最新版/);
    const vs = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
    assert.equal(vs.claimed, false);
    assert.equal(vs.code, 'HDKIT_VERSION_TOO_OLD');
    assert.match(vs.message ?? '', /插件版本过旧，请升级至正式版 2\.0\.0 及以上/);
    assert.ok(vs.remediation, 'the voucher exit folds the readable codeless 409 too');
  } finally {
    stub.restore();
  }
});

test('voucher exits surface the gate copy for a Cf-class gate message, never an invisible payload', async () => {
  const result = await voucherStatusUnder(() =>
    gateJson({ message: '\u200d', clientVersion: '2.0.0-next.0', minVersion: '2.0.0' }),
  );
  assert.equal(result.claimed, false);
  assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
  assert.match(result.message ?? '', /HDKIT_VERSION_TOO_OLD/, 'the gate copy path fires, not the raw payload');
  assert.ok(!rendersBlank(String(result.message ?? '')), 'never a visually blank voucher message');
});

test('an aborted codeless 409 on a voucher exit folds as the gate envelope, never the transport noise', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const fetch = installAbortingFetch(409, new TypeError('terminated'));
  try {
    const result = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
    assert.equal(fetch.calls(), 1);
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.match(result.message ?? '', /插件版本过旧/, 'the designed gate copy fires');
    assert.doesNotMatch(result.message ?? '', /terminated/, 'transport noise never surfaces as the message');
    assert.ok(result.remediation, 'the gate envelope carries the upgrade remediation');
  } finally {
    fetch.restore();
    restoreSeam();
  }
});

// ── 码字段收窄与中断 Error 分支统一（round 7）──
// 码字段是唯一没过清洗口的边界读：真值空白/Cf 码既击穿门禁折叠也击穿 409
// 不伪造码的规则；abort wrap 的 Error 分支只测清洗值真假、原样抛出原对象，
// 边缘空白/不可见字符存活到 MCP 边界。

test('a blank or pure-invisible code field is absent: the codeless 409 fold fires on every exit', async () => {
  for (const blankCode of ['   ', '​', '󠄀'] as const) {
    const stub = stubConnectSequence([
      () => jsonEnvelope({ code: blankCode, message: '插件版本过旧，请升级至正式版 2.0.0 及以上。' }, { status: 409 }),
    ]);
    try {
      const cu = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
      assert.equal(cu.ok, false, 'a blank code must not defeat the gate fold');
      assert.equal(cu.code, 'HDKIT_VERSION_TOO_OLD');
      assert.match(cu.message ?? '', /插件版本过旧，请升级至正式版 2\.0\.0 及以上/, 'the server copy surfaces');
      assert.match(cu.remediation!.hint, /当前 未知/);
      const vs = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
      assert.equal(vs.claimed, false);
      assert.equal(vs.code, 'HDKIT_VERSION_TOO_OLD');
      assert.ok(vs.remediation, 'the voucher exit folds too');
    } finally {
      stub.restore();
    }
  }
});

test('rendersBlank covers the halfwidth filler, variation selectors, the grapheme joiner, and Cc controls', () => {
  for (const ch of ['ﾠ', '︀', '️', '͏', '\u0007', '\u0000'] as const) {
    assertBlankCodepoint(ch);
  }
  // Mn 类收口决策（台账）：附着可见基底的组合附标渲染出符号，是真文本——
  // 只有零宽成员（变体选择子、U+034F 连字结合符）按空白处理
  assert.equal(rendersBlank('́'), false, 'a standalone combining accent renders a mark: real text by the scoping');
});

test('a blank-code gate exit never surfaces a visually blank code', async () => {
  const stub = stubConnectSequence([() => jsonEnvelope({ code: '   ', message: '插件版本过旧。' }, { status: 409 })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD', 'the folded code is the gate code, never the blank payload');
    assert.ok(!rendersBlank(String(result.code ?? '')));
  } finally {
    stub.restore();
  }
});

test('padded and invisible-edged Error reasons surface cleaned: both wrap branches identical', async () => {
  const restoreSeam = withRetrySeam('5,5');
  try {
    for (const reason of [new TypeError('  terminated  '), new TypeError('​terminated​')] as const) {
      const { err, calls } = await captureAbortRejection(500, reason);
      assert.equal(calls, 1);
      assert.equal(err.status, 500);
      assert.equal(err.message, 'terminated', 'the Error branch builds from the cleaned value, like the string branch');
    }
  } finally {
    restoreSeam();
  }
});

test('a code-bearing abort reason (the DOMException shape) folds as the gate on 409', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const fetch = installAbortingFetch(409, new DOMException('This operation was aborted', 'AbortError'));
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.status, 409);
    assert.equal(
      (err as { code?: unknown }).code,
      undefined,
      'the wrap never carries the transport-owned code property through',
    );
    const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.ok(result.remediation, 'the unknown-version remediation mints for an aborted 409');
    assertNoLeakyLiterals(result);
  } finally {
    fetch.restore();
    restoreSeam();
  }
});

test('a code-bearing abort reason on a 502 exhaustion surfaces the designed gateway code, never the numeric transport code', async () => {
  const restoreSeam = withRetrySeam('1');
  const fetch = installAbortingFetch(502, new DOMException('This operation was aborted', 'AbortError'));
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ExhaustedResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT', 'the designed gateway code, never the transport numeric 20');
    assert.notEqual(result.code, 20);
    assert.ok(String(result.message ?? '').length > 0, 'the cleaned reason surfaces as real text');
  } finally {
    fetch.restore();
    restoreSeam();
  }
});

// ── Default_Ignorable 权威 + 码点级边缘剥离 + fetch 层中断（round 8）──
// 权威换成 Unicode 属性类本身（\p{Default_Ignorable_Code_Point}）：同一
// "下一个 Unicode 边界"缺陷类连续复发七轮后，枚举收口为属性类。边缘剥离
// 按码点迭代（UTF-16 单元会漏掉星面区 Cf）。fetch 自身的拒绝（30s 定时器的
// AbortError 携 code 20）在 fetch 同缝守卫，不透传原对象。

test('rendersBlank follows the Default_Ignorable authority: every DI code point classifies blank', () => {
  const DI = /\p{Default_Ignorable_Code_Point}/u;
  let diCount = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (DI.test(ch)) {
      diCount += 1;
      assert.equal(rendersBlank(ch), true, `U+${cp.toString(16).toUpperCase()} is DI and must render blank`);
    }
  }
  assert.ok(diCount >= 1000, `the authority is the property class, not an enumeration (matched ${diCount})`);
  assert.equal(rendersBlank('插件'), false, 'real text stays visible');
});

test('cleanMessage strips astral blank edges by code point, not UTF-16 units', () => {
  assert.equal(cleanMessage('󠄀插件版本'), '插件版本', 'a leading astral DI char is an edge');
  assert.equal(cleanMessage('插件版本󠄀'), '插件版本', 'a trailing astral DI char is an edge');
  assert.equal(cleanMessage('󠄀插件󠄀版本󠄀'), '插件󠄀版本', 'interior astral DI chars are real text');
});

// 垫码参数化（round 8 星面区 + round 9 非 DI Cf）：同一清洗口，同一折叠
for (const [label, padding] of [
  ['an astral-padded', '󠄀'],
  ['a non-DI-Cf-padded', '\uFFF9'],
] as const) {
  test(`${label} gate code folds as the coded gate on every exit`, async () => {
    const stub = stubConnectSequence([
      () =>
        jsonEnvelope(
          {
            code: `HDKIT_VERSION_TOO_OLD${padding}`,
            message: '插件版本过旧。',
            clientVersion: '2.0.0-next.0',
            minVersion: '2.0.0',
          },
          { status: 409 },
        ),
    ]);
    try {
      const result = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
      assert.equal(result.ok, false);
      assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD', 'the padded code cleans to the gate code');
      assert.equal(result.clientVersion, '2.0.0-next.0', 'the coded-gate payload rides the fold');
      assert.equal(result.minVersion, '2.0.0');
      assert.match(result.remediation!.hint, /当前 2\.0\.0-next\.0/);
    } finally {
      stub.restore();
    }
  });
}

test('an astral-padded quota code reaches the quota envelope', async () => {
  const result = await connectUnder(
    () =>
      jsonEnvelope(
        { code: 'HDKIT_QUOTA_EXCEEDED󠄀', message: '沙箱并发配额已满（每账号最多 5 台实例）' },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    '5,5',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_QUOTA_EXCEEDED', 'the astral-padded code cleans to the quota code');
  assert.equal(result.retryAfter, '60');
  assert.match(result.remediation?.hint ?? '', /配额已满/);
});

test('a fetch-level abort surfaces the designed copy, never the transport numeric code', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    await assert.rejects(callTool('huaweicloud_sandbox_check_user', {}), (error: ExhaustedResult & Error) => {
      assert.match(error.message, /aborted/i, 'the real abort reason surfaces as real text');
      assert.notEqual((error as { code?: unknown }).code, 20, 'the transport numeric code never reaches the boundary');
      assert.equal((error as { code?: unknown }).code, undefined, 'the wrap carries no code property at all');
      assert.equal(error.status, undefined);
      return true;
    });
    global.fetch = async () => {
      throw new Error('   ');
    };
    await assert.rejects(callTool('huaweicloud_sandbox_check_user', {}), (error: ExhaustedResult & Error) => {
      assert.match(error.message, /hdkitservice request failed/, 'a blank reason falls to the designed wrap copy');
      assert.ok(!rendersBlank(error.message));
      return true;
    });
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

test('a fetch-level abort on connect is a single attempt with the wrap copy, no numeric code', async () => {
  const restoreSeam = withRetrySeam('5,5');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new DOMException('This operation was aborted', 'AbortError');
  };
  try {
    const err = await captureConnectRejection({ pool_type: 'ephemeral' });
    assert.equal(calls, 1, 'a statusless transport abort carries no gateway signal and is not retried');
    assert.equal(err.status, undefined);
    assert.equal((err as { code?: unknown }).code, undefined, 'never the transport numeric 20');
    assert.match(err.message, /aborted/i);
    assert.equal(err.connectRetries, 0);
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
});

test('a readable codeless JSON 502 exhaustion surfaces the designed gateway code, not the manufacture', async () => {
  const restoreSeam = withRetrySeam('1');
  const stub = stubConnectSequence([() => jsonEnvelope({ message: 'gateway busy' }, { status: 502 })]);
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ExhaustedResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT', 'the designed gateway code wins over the manufactured HTTP_502');
    assert.notEqual(result.code, 'HTTP_502');
    assert.equal(result.connectRetries, 1);
  } finally {
    stub.restore();
    restoreSeam();
  }
});

test('decorateExhaustedConnect tolerates getter-only carriers (the exported seam is safe)', () => {
  const carrier = new DOMException('This operation was aborted', 'AbortError');
  assert.doesNotThrow(() => decorateExhaustedConnect(carrier, 1));
  assert.equal(
    (carrier as { code?: unknown }).code,
    'HDKIT_GATEWAY_TIMEOUT',
    'the designed code lands despite the getter',
  );
  assert.equal((carrier as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
  assert.ok((carrier as { remediation?: { hint: string } }).remediation, 'the minted remediation lands');
});

// ── 非 DI 不可见 Cf（round 9）：19 个 UAX 44 从 DI 永久除名的码点 ──
// U+FFF9–U+FFFB 行间注释锚点与 U+13430–U+1343F 圣书体连字符——round 7 的
// \p{Cf} 类曾覆盖，round 8 的 DI 权威收口时遗漏。其余 12 个 Cf-非-DI 码点
// 渲染可见符号，保持真文本（台账记录边界）。

test('the 19 non-DI invisible Cf code points render blank: interlinear anchors and hieroglyph joiners', () => {
  let count = 0;
  for (let cp = 0xfff9; cp <= 0xfffb; cp++) {
    assertBlankCodepoint(String.fromCodePoint(cp));
    count += 1;
  }
  for (let cp = 0x13430; cp <= 0x1343f; cp++) {
    assertBlankCodepoint(String.fromCodePoint(cp));
    count += 1;
  }
  assert.equal(count, 19, 'exactly the two UAX-44-removed invisible ranges');
  // 其余 Cf-非-DI 码点渲染可见符号（0600 数字号、06DD 行间句读等）——真文本
  assert.equal(rendersBlank('؀'), false, 'Arabic number sign renders a mark: real text');
  assert.equal(rendersBlank('\u070F'), false, 'Syriac abbreviation mark renders: real text');
});

test('a U+FFF9 message on a codeless 409 folds as the gate on the voucher exit', async () => {
  const result = await voucherStatusUnder(() => jsonEnvelope({ message: '\uFFF9' }, { status: 409 }));
  assert.equal(result.claimed, false);
  assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
  assert.match(
    String(result.message ?? ''),
    /hdkitservice error|插件版本过旧/,
    'the build-seam fallback fires for a pure-FFF9 message',
  );
  assert.ok(!rendersBlank(String(result.message ?? '')), 'never a visually blank message');
  assert.ok(result.remediation, 'the unknown-version remediation mints');
});

test('a U+13430-padded or FFF9 code on a 502/504 exhaustion mints the designed gateway code', async () => {
  const fff9Result = await connectUnder(
    () => jsonEnvelope({ code: '\uFFF9', message: 'gateway busy' }, { status: 502 }),
    '1',
  );
  assert.equal(fff9Result.ok, false);
  assert.equal(fff9Result.code, 'HDKIT_GATEWAY_TIMEOUT', 'a blank code leaves no server code to keep');
  assert.equal(fff9Result.connectRetries, 1);
  const paddedResult = await connectUnder(() => jsonEnvelope({ code: 'HTTP_504\u{13430}' }, { status: 504 }), '1');
  assert.equal(paddedResult.ok, false);
  assert.equal(paddedResult.code, 'HDKIT_GATEWAY_TIMEOUT', 'an FFF9 edge stripped, HTTP_504 replaced on exhaustion');
});

test('decorateExhaustedConnect clones frozen and non-configurable carriers instead of throwing', () => {
  const frozen = Object.freeze(new Error('frozen carrier'));
  const out1 = decorateExhaustedConnect(frozen, 2);
  assert.notEqual(out1, frozen, 'a refusing carrier is replaced, not mutated');
  assert.equal((out1 as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.equal((out1 as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
  assert.ok((out1 as { remediation?: { hint: string } }).remediation, 'the minted remediation lands on the clone');

  const nonConfig = new Error('own non-configurable getter');
  Object.defineProperty(nonConfig, 'code', { get: () => 20, configurable: false });
  const out2 = decorateExhaustedConnect(nonConfig, 1);
  assert.notEqual(out2, nonConfig);
  assert.equal((out2 as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT', 'the transport numeric 20 never survives');
  assert.equal((out2 as { message?: string }).message, 'own non-configurable getter', 'the real message carries');
  assert.ok((out2 as { remediation?: { hint: string } }).remediation);
});

// ── 伪造码的最后表面 + 非码点切片 + 拒绝载体收口（round 10）──
// 耗尽折叠换码后，消息里伪造的 "HTTP_x: " 前缀仍残留——一个信封两个码语义。
// 非 JSON 切片按 UTF-16 单元截断会造出孤立代理对，阻断所有清洗。拒绝载体的
// 就地装填必须可回滚，克隆必须携带不可枚举业务字段且不引爆抛出型 getter。

test('readable codeless JSON 502 and 504 exhaustions surface one code semantics, never the manufactured prefix', async () => {
  const r502 = await connectUnder(() => jsonEnvelope({ message: 'gateway busy' }, { status: 502 }), '1');
  assert.equal(r502.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.doesNotMatch(String(r502.message ?? ''), /HTTP_50/, 'the manufactured prefix never survives');
  assert.match(String(r502.message ?? ''), /gateway busy/, 'the server copy carries');
  const r504 = await connectUnder(() => jsonEnvelope({ message: 'upstream timed out' }, { status: 504 }), '1');
  assert.equal(r504.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.doesNotMatch(String(r504.message ?? ''), /HTTP_50/);
  assert.match(String(r504.message ?? ''), /upstream timed out/);
  // 控制行：服务端亲署的网关码（非伪造）保留现行行为——信封码与消息前缀一致
  const authored = await connectUnder(
    () => jsonEnvelope({ code: 'HDKIT_GATEWAY_TIMEOUT', message: 'gateway busy' }, { status: 502 }),
    '1',
  );
  assert.equal(authored.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(authored.message ?? ''), /HDKIT_GATEWAY_TIMEOUT: gateway busy/, 'authored code keeps its prefix');
});

test('a blank remainder after prefix stripping falls to the designed transient copy', () => {
  // 请求层的构建口保证消息非空（hdkitservice error 兜底），剥后为空只在
  // 导出面构造：手构载体直测装饰分支
  const carrier = Object.assign(new Error('HTTP_502: \u200b'), { code: 'HTTP_502' });
  const out = decorateExhaustedConnect(carrier, 1) as { code?: string; message?: string };
  assert.equal(out.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(out.message ?? ''), /网关 502\/504 超时/, 'the designed copy fires for a blank remainder');
  assert.ok(!rendersBlank(String(out.message ?? '')));
});

test('a non-JSON body cut at the code-point boundary leaves no lone surrogate and no invisible run', async () => {
  // 199 个零宽空格 + 可见星面区字符：按 UTF-16 单元截断会把星面区对截成孤立
  // 高代理，阻断清洗——99 个 ZWSP 随之骑进折叠消息
  const straddling = '\u200b'.repeat(199) + '𓀀';
  const result = await connectUnder(() => htmlPage(502, straddling), '1');
  assert.equal(result.ok, false);
  const message = String(result.message ?? '');
  assert.ok(!message.includes('\u200b'), 'no invisible Cf rides the folded message');
  assert.ok(!/\uD800-\uDBFF(?![\uDC00-\uDFFF])/.test(message), 'no unpaired surrogate');
});

test('decorateExhaustedConnect rolls back the original when the carrier refuses mid-decoration', () => {
  const carrier = new Error('refuses code only');
  Object.defineProperty(carrier, 'code', { get: () => 20, configurable: false });
  const out = decorateExhaustedConnect(carrier, 1);
  assert.notEqual(out, carrier, 'a refusing carrier gets the clone');
  assert.equal(
    'gatewayRetryExhausted' in carrier,
    false,
    'the half-applied decoration is rolled back — the original cannot fold with the transport code',
  );
  assert.equal((out as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.equal((out as { connectRetries?: number }).connectRetries, 1, 'the clone carries the attempt count');
});

test('the clone carries non-enumerable business fields and survives throwing getters', () => {
  const carrier = new Error('throwing getter');
  Object.defineProperty(carrier, 'coreHoursExhausted', { value: true, enumerable: false });
  Object.defineProperty(carrier, 'message', {
    get() {
      throw new TypeError('getter detonates');
    },
    configurable: true,
  });
  Object.defineProperty(carrier, 'code', { get: () => 20, configurable: false });
  let out: unknown;
  assert.doesNotThrow(() => {
    out = decorateExhaustedConnect(carrier, 2);
  }, 'a throwing message getter never detonates the clone read');
  assert.equal((out as { coreHoursExhausted?: boolean }).coreHoursExhausted, true, 'non-enumerable fields carry');
  assert.equal((out as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.ok((out as { remediation?: { hint: string } }).remediation, 'the minted remediation lands');
  assert.ok(
    !rendersBlank(String((out as { message?: string }).message ?? '')),
    'the clone message is real text or the designed copy, never blank',
  );
});

// ── 装饰缝的读卫与拼写判定（round 11）──
// code/remediation 的裸读在快照防护之前引爆抛出型 getter；mint 与剥除判定
// 用原始拼写——内部不可见字符（HTTP_5⁠02）与边缘垫码（HTTP_504+ZWSP）都
// 绕过 /^HTTP_\d+$/，一个缝两种行为；前缀剥除不循环，翻倍前缀只剥一层。

test('throwing code and remediation getters never detonate the decoration seam', () => {
  const codeThrower = new Error('code getter throws') as Error & { code?: unknown };
  Object.defineProperty(codeThrower, 'code', {
    get() {
      throw new TypeError('code detonates');
    },
    configurable: true,
  });
  const out1 = decorateExhaustedConnect(codeThrower, 1) as { code?: string; remediation?: unknown };
  assert.equal(out1.code, 'HDKIT_GATEWAY_TIMEOUT', 'a refusing code read is absent — the mint fires');
  assert.ok(out1.remediation, 'the minted remediation lands');

  const remediationThrower = new Error('remediation getter throws') as Error & {
    code?: unknown;
    remediation?: unknown;
  };
  remediationThrower.code = 'HTTP_502';
  Object.defineProperty(remediationThrower, 'remediation', {
    get() {
      throw new TypeError('remediation detonates');
    },
    configurable: true,
  });
  const out2 = decorateExhaustedConnect(remediationThrower, 1) as { code?: string; remediation?: unknown };
  assert.equal(out2.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.ok(out2.remediation, 'a refusing remediation read is absent — the mint fires');
});

test('padded HTTP_x spellings mint and strip on both sides of the seam', () => {
  for (const padded of ['HTTP_504\u200b', '  HTTP_504  '] as const) {
    const carrier = Object.assign(new Error(`${padded}: gateway busy`), { code: padded });
    const out = decorateExhaustedConnect(carrier, 1) as { code?: string; message?: string };
    assert.equal(out.code, 'HDKIT_GATEWAY_TIMEOUT', 'a padded spelling mints the designed code');
    assert.doesNotMatch(String(out.message ?? ''), /HTTP_50/, 'the prefix is stripped');
    assert.match(String(out.message ?? ''), /gateway busy/, 'the server copy carries');
  }
});

test('internal-invisible HTTP_x spellings are manufactured: word-joiner and internal Cf', () => {
  for (const invisibleCode of ['HTTP_5\u206002', 'HTTP_50\u200b2'] as const) {
    const carrier = Object.assign(new Error(`${invisibleCode}: gateway busy`), { code: invisibleCode });
    const out = decorateExhaustedConnect(carrier, 1) as { code?: string; message?: string };
    assert.equal(out.code, 'HDKIT_GATEWAY_TIMEOUT', 'an invisible-woven spelling is not a business code');
    assert.doesNotMatch(String(out.message ?? ''), /HTTP_50/);
    assert.match(String(out.message ?? ''), /gateway busy/);
  }
  // 控制行：真实业务码不受影响
  const business = Object.assign(new Error('HDKIT_UPSTREAM_ERROR: burn core'), { code: 'HDKIT_UPSTREAM_ERROR' });
  const outBiz = decorateExhaustedConnect(business, 1) as { code?: string; message?: string };
  assert.equal(outBiz.code, 'HDKIT_UPSTREAM_ERROR');
  assert.match(String(outBiz.message ?? ''), /burn core/);
});

test('doubled prefixes strip in a loop; message-equals-code falls to the designed copy', () => {
  const doubled = Object.assign(new Error('HTTP_502: HTTP_502: gateway busy'), { code: 'HTTP_502' });
  const out1 = decorateExhaustedConnect(doubled, 1) as { code?: string; message?: string };
  assert.equal(out1.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(out1.message ?? ''), /gateway busy/, 'both manufactured prefixes strip');
  assert.doesNotMatch(String(out1.message ?? ''), /HTTP_50/);

  const equals = Object.assign(new Error('HTTP_502: HTTP_502'), { code: 'HTTP_502' });
  const out2 = decorateExhaustedConnect(equals, 1) as { code?: string; message?: string };
  assert.equal(out2.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(out2.message ?? ''), /网关 502\/504 超时/, 'no server copy remains — the designed copy fires');
});

test('a doubled-prefix message through the request layer surfaces the server copy once', async () => {
  const result = await connectUnder(
    () => jsonEnvelope({ code: 'HTTP_502', message: 'HTTP_502: gateway busy' }, { status: 502 }),
    '1',
  );
  assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(result.message ?? ''), /gateway busy/);
  assert.equal(String(result.message ?? '').match(/HTTP_50/g)?.length ?? 0, 0, 'no manufactured spelling remains');
});

test('versionGateMessage and transientExhaustionResult survive throwing message getters', () => {
  const carrier = new Error('never read') as Error & { code?: string; gatewayRetryExhausted?: boolean };
  Object.defineProperty(carrier, 'message', {
    get() {
      throw new TypeError('message detonates');
    },
    configurable: true,
  });
  carrier.code = 'HDKIT_VERSION_TOO_OLD';
  let gateMessage = '';
  assert.doesNotThrow(() => {
    gateMessage = versionGateMessage(carrier);
  });
  assert.match(gateMessage, /插件版本过旧/, 'the gate fallback copy fires');

  const exhausted = new Error('never read') as Error & {
    gatewayRetryExhausted?: boolean;
    connectRetries?: number;
  };
  Object.defineProperty(exhausted, 'message', {
    get() {
      throw new TypeError('message detonates');
    },
    configurable: true,
  });
  exhausted.gatewayRetryExhausted = true;
  exhausted.connectRetries = 1;
  let fold: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    fold = transientExhaustionResult(exhausted);
  });
  assert.equal(fold?.ok, false);
  assert.match(String(fold?.message ?? ''), /connect 持续遭遇网关/, 'the exhaustion fallback fires');
});

test('the clone carries symbol-keyed fields and non-object carriers return a plain decorated Error', () => {
  const sym = Symbol('business');
  const carrier = new Error('symbol carrier') as Error & Record<PropertyKey, unknown>;
  carrier[sym] = 'tag';
  Object.defineProperty(carrier, 'code', { get: () => 20, configurable: false });
  const out = decorateExhaustedConnect(carrier, 1) as Record<PropertyKey, unknown>;
  assert.notEqual(out, carrier);
  assert.equal(out[sym], 'tag', 'symbol-keyed own fields carry');
  assert.equal(out['code'], 'HDKIT_GATEWAY_TIMEOUT');

  for (const nonObject of ['primitive', null, 42] as const) {
    let plain: unknown;
    assert.doesNotThrow(
      () => {
        plain = decorateExhaustedConnect(nonObject, 1);
      },
      `${String(nonObject)} never detonates the seam`,
    );
    assert.ok(plain instanceof Error, 'a plain decorated Error returns');
    assert.equal((plain as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
    assert.ok((plain as { remediation?: unknown }).remediation);
  }
});

test('a large non-JSON body bounds the snippet allocation', async () => {
  const restoreSeam = withRetrySeam('0');
  const originalFetch = global.fetch;
  const bigBody = 'x'.repeat(32 * 1024 * 1024);
  global.fetch = async () =>
    ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => bigBody,
    }) as unknown as Response;
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  try {
    await captureConnectRejection({});
  } finally {
    global.fetch = originalFetch;
    restoreSeam();
  }
  const delta = process.memoryUsage().heapUsed - before;
  assert.ok(
    delta < 150 * 1024 * 1024,
    `the snippet path must not materialize the whole body (heap delta ${(delta / 1024 / 1024).toFixed(0)}MB)`,
  );
});

// ── 码身份的规范裁决（round 12）──
// 织入码（HDKIT_VERSION_T\u200bOO_OLD）在一切身份比较处按规范拼写裁决——
// 模块内码身份比较全部走 canonCode（剔除全部空白渲染字符），不再裸读。

test('a woven gate code on a 409 folds at the sandbox exit and the voucher exit', async () => {
  const woven = 'HDKIT_VERSION_T\u200bOO_OLD';
  const stub = stubConnectSequence([
    () =>
      jsonEnvelope(
        { code: woven, message: '插件版本过旧。', clientVersion: '2.0.0-next.0', minVersion: '2.0.0' },
        { status: 409 },
      ),
  ]);
  try {
    const cu = (await callTool('huaweicloud_sandbox_check_user', {})) as GateResult;
    assert.equal(cu.ok, false, 'a woven gate code is the gate');
    assert.equal(cu.code, 'HDKIT_VERSION_TOO_OLD', 'the surfaced code is the canonical gate code');
    assert.equal(cu.clientVersion, '2.0.0-next.0', 'the coded-gate payload rides the fold');
    assert.equal(cu.minVersion, '2.0.0');
    assert.match(cu.remediation!.hint, /当前 2\.0\.0-next\.0/);
    const vs = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
    assert.equal(vs.claimed, false);
    assert.equal(vs.code, 'HDKIT_VERSION_TOO_OLD');
    assert.ok(vs.remediation, 'the voucher exit folds the woven gate code');
  } finally {
    stub.restore();
  }
  // 同一出口在 callTool 重试判定上：织入门禁码不重试（非瞬时）
  const retryStub = stubConnectSequence([
    () => jsonEnvelope({ code: woven, message: '插件版本过旧。' }, { status: 409 }),
  ]);
  try {
    const err = await captureConnectRejection({});
    assert.equal(retryStub.calls(), 1, 'the woven gate code is never retried');
    assert.equal(err.code, woven, 'the raw spelling rides the error');
  } finally {
    retryStub.restore();
  }
});

test('a woven quota code under a rewritten 502 costs one fetch and keeps its quota remediation', async () => {
  const result = await connectUnder(
    () =>
      jsonEnvelope(
        { code: 'HDKIT_QUOTA_EXCEE\u200bDED', message: '沙箱并发配额已满' },
        { status: 502, headers: { 'Retry-After': '60' } },
      ),
    '5,5',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_QUOTA_EXCEEDED', 'the canonical quota code rides the envelope');
  assert.equal(result.retryAfter, '60');
  assert.match(result.remediation?.hint ?? '', /配额已满/, 'the quota remediation survives — no gateway re-label');
});

test('a woven remainder falls to the designed copy; the woven designed-code twin matches the clean twin', () => {
  // 干净码 + 织入副本：交叉形态同样剥除（规范比较）
  const wovenCopy = Object.assign(new Error('HTTP_5\u206002: gateway busy'), { code: 'HTTP_502' });
  const out1 = decorateExhaustedConnect(wovenCopy, 1) as { code?: string; message?: string };
  assert.equal(out1.code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.match(String(out1.message ?? ''), /gateway busy/, 'the canonical prefix match strips the woven copy');
  assert.doesNotMatch(String(out1.message ?? ''), /HTTP_50/);
  // 织入且无冒号的残留 → 设计文案
  const wovenNoColon = Object.assign(new Error('HTTP_5\u206002'), { code: 'HTTP_502' });
  const out2 = decorateExhaustedConnect(wovenNoColon, 1) as { code?: string; message?: string };
  assert.match(
    String(out2.message ?? ''),
    /网关 502\/504 超时/,
    'a woven spelling-only remainder falls to the designed copy',
  );
  // 设计码的织入孪生与干净孪生行为一致：亲署保留、空消息铸文案
  const wovenTwin = Object.assign(new Error('   '), { code: 'HDKIT_GATEWAY_TI\u200bMEOUT' });
  const out3 = decorateExhaustedConnect(wovenTwin, 1) as { code?: unknown; message?: string };
  assert.equal(out3.code, 'HDKIT_GATEWAY_TI\u200bMEOUT', 'the authored woven twin is preserved like the clean twin');
  assert.match(String(out3.message ?? ''), /网关 502\/504 超时/, 'the designed-copy branch fires canonically');
});

test('blank-separator HTTP spellings are the manufactured family: NBSP, ZWSP, space, ideographic space', () => {
  for (const separator of ['\u00a0', '\u200b', ' ', '\u3000'] as const) {
    const spelling = `HTTP${separator}502`;
    const carrier = Object.assign(new Error(`${spelling}: gateway busy`), { code: spelling });
    const out = decorateExhaustedConnect(carrier, 1) as { code?: string; message?: string };
    assert.equal(
      out.code,
      'HDKIT_GATEWAY_TIMEOUT',
      `the ${separator.charCodeAt(0).toString(16)} separator spelling mints`,
    );
    assert.match(String(out.message ?? ''), /gateway busy/);
    assert.doesNotMatch(String(out.message ?? ''), /HTTP/);
    // 重试判定同口径：织入（非替换）的配额码按规范拼写识别为客户端裁决
    const quotaCarrier = Object.assign(new Error('quota'), {
      code: 'HDKIT_QUOTA_EXCEE\u200bDED',
    });
    assert.equal(
      isNonRetryableBusinessError(quotaCarrier),
      true,
      'a woven-in quota code is still a client verdict — recognized, not transient',
    );
  }
});

test('the fold exits read every field safely; the clone survives revoked proxies', () => {
  const foldCarrier = new Error('never read') as Error & Record<PropertyKey, unknown>;
  Object.defineProperty(foldCarrier, 'gatewayRetryExhausted', {
    get() {
      throw new TypeError('detonates');
    },
    configurable: true,
  });
  let fold: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    fold = transientExhaustionResult(foldCarrier);
  });
  assert.equal(fold, undefined, 'a refusing marker read is absent — no fold, no detonation');

  const gateCarrier = new Error('gate read') as Error & Record<PropertyKey, unknown>;
  Object.defineProperty(gateCarrier, 'code', {
    get() {
      throw new TypeError('detonates');
    },
    configurable: true,
  });
  let gate: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    gate = versionGateResult(gateCarrier);
  });
  assert.equal(gate, undefined, 'a refusing code read is absent — no gate fold, no detonation');

  const revoked = Proxy.revocable(new Error('revoked'), {});
  revoked.revoke();
  let plain: unknown;
  assert.doesNotThrow(() => {
    plain = decorateExhaustedConnect(revoked.proxy, 1);
  }, 'a revoked proxy carrier never detonates the seam');
  assert.ok(plain instanceof Error);
  assert.equal((plain as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.ok((plain as { remediation?: unknown }).remediation);
});

// ── 类型收窄回归、码身份收尾、分隔符互换（round 13）──
// round-12 的安全读丢了既有的 typeof-string 收窄——非字符串版本字段在清洗口
// 迭代时抛 TypeError。织入的 devbridge 配额码是边界上最后一个未走规范的码
// 身份比较。无码识别器的裸读在带 409 status 的抛出型载体上引爆。前缀骨架
// 把下划线当字面量——空白字符顶替分隔符的交叉形态两侧都存活。

test('non-string version fields narrow away: numeric and object payloads never throw the fold', () => {
  const numeric = Object.assign(new Error('gate'), {
    code: 'HDKIT_VERSION_TOO_OLD',
    clientVersion: 2,
    minVersion: 7,
  });
  let out: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    out = versionGateResult(numeric);
  }, 'a numeric version field never detonates the fold');
  assert.equal(out?.ok, false);
  assert.equal(out?.clientVersion, undefined, 'a numeric version narrows away');
  assert.equal(out?.minVersion, undefined);
  assert.match(String(out?.remediation ? (out.remediation as { hint: string }).hint : ''), /当前 未知/);

  const objectVersion = Object.assign(new Error('gate'), {
    code: 'HDKIT_VERSION_TOO_OLD',
    clientVersion: { major: 2 },
  });
  let out2: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    out2 = versionGateResult(objectVersion);
  });
  assert.equal(out2?.clientVersion, undefined, 'an object version narrows away');
  assert.equal(out2?.minVersion, undefined);

  const stringControl = Object.assign(new Error('gate'), {
    code: 'HDKIT_VERSION_TOO_OLD',
    clientVersion: '2.0.0-next.0',
  });
  const out3 = versionGateResult(stringControl) as Record<string, unknown>;
  assert.equal(out3.clientVersion, '2.0.0-next.0', 'the string control still rides');
});

test('the codeless recognizer reads status, bodyUnreadable, and code through the safe wrapper', () => {
  const codeThrower = Object.assign(new Error('boom'), { status: 409 });
  Object.defineProperty(codeThrower, 'code', {
    get() {
      throw new TypeError('code getter detonates');
    },
    configurable: true,
  });
  let gate: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    gate = versionGateResult(codeThrower);
  }, 'a throwing code getter with status 409 never detonates the recognizer');
  assert.equal(gate?.ok, false, 'a refusing code read is absent — the 409 folds as codeless');
  assert.equal(gate?.code, 'HDKIT_VERSION_TOO_OLD');

  const markerThrower = Object.assign(new Error('boom'), { status: 409 });
  Object.defineProperty(markerThrower, 'bodyUnreadable', {
    get() {
      throw new TypeError('bodyUnreadable getter detonates');
    },
    configurable: true,
  });
  let gate2: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    gate2 = versionGateResult(markerThrower);
  }, 'a throwing bodyUnreadable getter never detonates the recognizer');
  assert.equal(gate2?.ok, false, 'a refusing marker read is absent — the plain codeless 409 still folds');
  assert.equal(gate2?.code, 'HDKIT_VERSION_TOO_OLD');

  const revoked = Proxy.revocable(Object.assign(new Error('revoked 409'), { status: 409 }), {});
  revoked.revoke();
  let gate3: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    gate3 = versionGateResult(revoked.proxy);
  }, 'a revoked proxy carrier never detonates the recognizer');
  assert.equal(gate3, undefined, 'every read is absent on a revoked proxy — no gate, no throw');
});

test('the separator interchange strips both directions: blank for underscore and the mirror', () => {
  for (const [label, code, message, expectServer] of [
    ['clean code + blank-for-underscore copy', 'HTTP_502', 'HTTP\u00a0502: gateway busy', true],
    ['clean code + space-for-underscore copy', 'HTTP_502', 'HTTP 502: gateway busy', true],
    ['blank-form code + underscore copy', 'HTTP\u00a0502', 'HTTP_502: gateway busy', true],
    ['blank-form code + ideographic copy', 'HTTP\u3000502', 'HTTP\u3000502: gateway busy', true],
    ['authored + woven spelling-only copy', 'HTTP_502', 'HTTP\u00a0502', false],
    ['codeless (client-minted) + woven copy', 'HTTP_502', 'HTTP_502: HTTP\u00a0502: gateway busy', true],
  ] as const) {
    const carrier = Object.assign(new Error(String(message)), { code });
    const out = decorateExhaustedConnect(carrier, 1) as { code?: string; message?: string };
    assert.equal(out.code, 'HDKIT_GATEWAY_TIMEOUT', `${label}: mints`);
    if (expectServer) {
      assert.match(String(out.message ?? ''), /gateway busy/, `${label}: the server copy carries`);
    } else {
      assert.match(String(out.message ?? ''), /网关 502\/504 超时/, `${label}: the designed copy fires`);
    }
    assert.ok(!/HTTP[^\d]/.test(String(out.message ?? '')), `${label}: no manufactured spelling remains`);
  }
});

test('a swallowed-set proxy falls to the clone: the marker must actually land', () => {
  const base = Object.assign(new Error('swallow'), {});
  const proxy = new Proxy(base, {
    set() {
      return true;
    },
    get(target, key) {
      return (target as unknown as Record<string | symbol, unknown>)[key];
    },
  });
  const out = decorateExhaustedConnect(proxy, 1);
  assert.notEqual(out, proxy, 'a proxy that swallows writes is not returned as decorated');
  assert.ok(out instanceof Error, 'the clone carries the decoration');
  assert.equal((out as { code?: string }).code, 'HDKIT_GATEWAY_TIMEOUT');
  assert.equal((out as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted, true);
  assert.equal(
    (proxy as { gatewayRetryExhausted?: boolean }).gatewayRetryExhausted,
    undefined,
    'the proxy stays undecorated',
  );
  // 折叠在返回值上生效
  const fold = transientExhaustionResult(out);
  assert.equal(fold?.ok, false, 'the fold fires on the clone');
});
