import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

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
const { connectRetryDelaysMs } = await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkit-gate.ts');
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
    process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = 'bogus';
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000]);
    delete process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS;
    assert.deepEqual(connectRetryDelaysMs(), [30000, 45000]);
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
  const stub = stubConnectSequence([() => jsonEnvelope(VERSION_GATE_409, { status: 409 })]);
  try {
    const result = (await callTool('huaweicloud_voucher_status', {})) as GateResult & { claimed?: boolean };
    // voucher 三出口保持 claimed:false 信封（dev e1255a4b voucherErrorResult 语义），
    // 门禁字段附加其上而非 ok:false 形态
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assertGatePayload(result);
  } finally {
    stub.restore();
  }
});

// ── callTool 层：瞬时耗尽的结构化折叠（v2 扩展；dev 在此路径裸抛）──

test('callTool connect: gateway 502 exhaustion returns ok:false with the attempt count and transient remediation', async () => {
  const restoreSeam = withRetrySeam('5');
  const stub = stubConnectSequence([() => htmlPage(502, '<html>502 Bad Gateway</html>')]);
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ExhaustedResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_GATEWAY_TIMEOUT');
    assert.equal(result.connectRetries, 1);
    assert.ok(result.remediation);
    assert.match(result.remediation!.hint, /网关/);
    assert.match(result.remediation!.hint, /重试 1 次/);
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
    restoreSeam();
  }
});
