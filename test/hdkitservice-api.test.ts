import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

// Every test in this file stubs global.fetch and asserts its envelopes:
// the direct branch of hdkitRequest is the premise. The shared harness
// establishes "no proxy" from every source the resolver reads and a
// hermetic HUAWEICLOUD_HOME, for the whole file (see fetch-stub-harness.ts).
const restoreFetchEnv = isolateDirectFetchEnv();

after(() => {
  restoreFetchEnv();
});

const { hdkitConnect, hdkitVoucherStatus, hdkitVoucherClaim, hdkitCompetitionVoucherClaim, hdkitListApiKeys } =
  await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts');
const { clearRuntimeCredentials } = await import('../plugins/huaweicloud-core/src/auth/credentials.ts');

test('hdkitservice connect parses backend traceId (camelCase) on error', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url, _opts) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        code: 'HDKIT_INTERNAL',
        message: '服务内部错误',
        traceId: 'trace-123',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const err = await hdkitConnect({}).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected hdkitConnect to reject');
    assert.equal(err.message, 'HDKIT_INTERNAL: 服务内部错误 [trace: trace-123]');
    assert.equal(err.code, 'HDKIT_INTERNAL');
    assert.equal(err.status, 500);
    assert.equal(err.traceId, 'trace-123');
    assert.equal(requestedUrl, 'https://example.test/hdkitservice/connect');
  } finally {
    global.fetch = originalFetch;
  }
});

type VoucherResult = {
  claimed: boolean;
  code: unknown;
  message: string;
  remediation?: { hint: string; steps: string[] };
};

test('voucher status returns CRED_MISSING when credentials are absent', async () => {
  const savedAk = process.env.HW_ACCESS_KEY;
  const savedSk = process.env.HW_SECRET_KEY;
  const savedHome = process.env.HUAWEICLOUD_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hdkit-test-'));
  try {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    process.env.HUAWEICLOUD_HOME = tmpHome;
    clearRuntimeCredentials();

    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_MISSING');
    // #900: resolveCredentials now throws the unified Chinese messageZh, which
    // hdkitVoucherStatus's catch maps into result.message.
    assert.match(result.message, /未配置华为云凭证/);
  } finally {
    if (savedAk === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = savedAk;
    if (savedSk === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = savedSk;
    if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedHome;
    clearRuntimeCredentials();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('voucher claim passes through error code and message on non-2xx', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherClaim('some-domain')) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_INTERNAL');
    assert.match(result.message, /HDKIT_INTERNAL/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher status returns remediation when HDKIT_CRED_INVALID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_CRED_INVALID', message: '凭证已失效' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_INVALID');
    assert.ok(result.remediation, 'expected remediation field to exist');
    assert.equal(result.remediation.hint, '已保存的凭证(S1)可能已失效。请执行以下操作之一：');
    assert.ok(Array.isArray(result.remediation.steps));
    assert.equal(result.remediation.steps.length, 3);
    assert.match(result.remediation.steps[0], /huaweicloud_auth_status/);
    assert.match(result.remediation.steps[1], /huaweicloud_auth_switch action=clear/);
    assert.match(result.remediation.steps[2], /auth init/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher claim returns remediation when HDKIT_CRED_INVALID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_CRED_INVALID', message: '凭证已失效' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherClaim('some-domain')) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_INVALID');
    assert.ok(result.remediation, 'expected remediation field to exist');
    assert.equal(result.remediation.hint, '已保存的凭证(S1)可能已失效。请执行以下操作之一：');
    assert.ok(Array.isArray(result.remediation.steps));
    assert.equal(result.remediation.steps.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher status does NOT include remediation for non-CRED_INVALID errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_INTERNAL');
    assert.equal(result.remediation, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('competition voucher claim posts to the competition endpoint and passes through errors', async () => {
  const originalFetch = global.fetch;
  const calls: string[] = [];
  global.fetch = async (url, opts) => {
    calls.push(`${String(url)} ${(opts as { method?: string }).method ?? ''}`);
    return new Response(JSON.stringify({ code: 'HDKIT_NOT_SIGNED_UP', message: '未报名该赛事' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = (await hdkitCompetitionVoucherClaim('some-domain')) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_NOT_SIGNED_UP');
    assert.match(result.message, /HDKIT_NOT_SIGNED_UP/);
    assert.ok(
      calls.length === 1 && calls[0]!.includes('/competition/voucher/claim') && calls[0]!.endsWith('POST'),
      `expected one POST to competition/voucher/claim, got: ${calls.join(', ')}`,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('competition voucher claim carries its own fallback message on network failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('socket hang up');
  };
  try {
    const result = (await hdkitCompetitionVoucherClaim()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.match(result.message ?? '', /Competition voucher service unavailable|socket hang up/);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 两池：pool_type 透传与钉扎 ──

// Body-capture stub for the connect request: records the JSON body and
// replays a fixed 200 envelope.
function stubConnectCapture(payload: unknown): { restore: () => void; body: () => Record<string, unknown> } {
  const originalFetch = global.fetch;
  let captured: string | undefined;
  global.fetch = async (_url, opts) => {
    captured = (opts as { body?: string }).body;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    restore: () => {
      global.fetch = originalFetch;
    },
    body: () => JSON.parse(String(captured)) as Record<string, unknown>,
  };
}

// Fixed-envelope error stub: the 429 dual-code and burn-core faces.
function stubErrorResponse(payload: unknown, init: ResponseInit): () => void {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' }, ...init });
  return () => {
    global.fetch = originalFetch;
  };
}

interface CapturedError {
  message?: string;
  code?: string;
  status?: number;
  retryAfter?: string;
  coreHoursExhausted?: boolean;
  remediation?: { hint: string; steps: string[] };
}

async function captureConnectRejection(options: Record<string, unknown>): Promise<CapturedError> {
  const outcome = await hdkitConnect(options).then(
    () => null,
    (error) => error,
  );
  assert.ok(outcome, 'expected rejection');
  return outcome as CapturedError;
}

test('hdkitConnect passes pool_type through without template pinning by default', async () => {
  // T5 环境隔离：预删钉扎变量并保存宿主原值，结束恢复（宿主设了 HW_POOL_TEMPLATE_* 时本用例仍须成立）
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  const savedPer = process.env.HW_POOL_TEMPLATE_PERSISTENT;
  delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
  const stub = stubConnectCapture({
    session_id: 's1',
    dev_stage_id: 'd1',
    pool_type: 'persistent',
    template_id: 'tplp',
  });
  try {
    const result = await hdkitConnect({ pool_type: 'persistent' });
    const body = stub.body();
    assert.equal(body.pool_type, 'persistent');
    assert.equal(body.template_id, undefined); // 未钉扎：模板由服务端权威映射
    assert.equal(result.pool_type, 'persistent');
  } finally {
    stub.restore();
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
    if (savedPer === undefined) delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
    else process.env.HW_POOL_TEMPLATE_PERSISTENT = savedPer;
  }
});

test('hdkitConnect attaches pinned template when HW_POOL_TEMPLATE_* is configured', async () => {
  // T5 环境隔离：保存宿主原值，结束恢复（而非无条件删除）
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  process.env.HW_POOL_TEMPLATE_EPHEMERAL = 'pinned-eph-tpl';
  const stub = stubConnectCapture({ session_id: 's1', dev_stage_id: 'd1' });
  try {
    await hdkitConnect({ pool_type: 'ephemeral' });
    const body = stub.body();
    assert.equal(body.pool_type, 'ephemeral');
    assert.equal(body.template_id, 'pinned-eph-tpl'); // 钉扎：附带映射模板（老服务端兼容）
  } finally {
    stub.restore();
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
  }
});

// ── T6 显式 template_id 优先于钉扎 ──

test('hdkitConnect keeps explicit template_id over pinned template', async () => {
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  process.env.HW_POOL_TEMPLATE_EPHEMERAL = 'pinned-eph-tpl';
  const stub = stubConnectCapture({ session_id: 's1', dev_stage_id: 'd1' });
  try {
    await hdkitConnect({ pool_type: 'ephemeral', template_id: 'explicit-tpl' });
    const body = stub.body();
    assert.equal(body.template_id, 'explicit-tpl'); // 显式模板优先，钉扎不覆盖
    assert.equal(body.pool_type, 'ephemeral');
  } finally {
    stub.restore();
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
  }
});

// ── 429 双错误码结构化处理 ──

test('HDKIT_QUOTA_EXCEEDED carries retryAfter and release-oriented remediation', async () => {
  const restore = stubErrorResponse(
    {
      code: 'HDKIT_QUOTA_EXCEEDED',
      message: '沙箱并发配额已满（每账号最多 5 台实例），请释放闲置沙箱后重试',
    },
    { status: 429, headers: { 'Retry-After': '60' } },
  );
  try {
    const err = await captureConnectRejection({ pool_type: 'ephemeral' });
    assert.equal(err.code, 'HDKIT_QUOTA_EXCEEDED');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, '60');
    assert.ok(err.remediation, 'expected remediation');
    assert.match(err.remediation.hint, /配额已满/);
    assert.ok(Array.isArray(err.remediation.steps));
    assert.match(err.remediation.steps.join(' '), /复用/); // 引导复用/释放，而非重试
  } finally {
    restore();
  }
});

test('HDKIT_CAPACITY_INSUFFICIENT passes the final server copy through untouched', async () => {
  const finalCopy = 'DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！';
  const restore = stubErrorResponse(
    { code: 'HDKIT_CAPACITY_INSUFFICIENT', message: finalCopy },
    { status: 429, headers: { 'Retry-After': '60' } },
  );
  try {
    const err = await captureConnectRejection({ pool_type: 'ephemeral' });
    assert.equal(err.code, 'HDKIT_CAPACITY_INSUFFICIENT');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, '60');
    assert.equal(err.message, finalCopy);
    assert.equal(err.remediation, undefined, 'capacity copy must not be wrapped in remediation');
  } finally {
    restore();
  }
});

// ── 烧核播报（HD.97520422 消息内识别）──

test('core-hours exhausted upstream code surfaces friendly remediation', async () => {
  const restore = stubErrorResponse(
    {
      code: 'HDKIT_UPSTREAM_ERROR',
      message:
        '沙箱编排上游调用失败: GET /open-api-public/v2/devenvs upstream error HD.97520422: The remaining core hours has been used up',
    },
    { status: 502 },
  );
  try {
    const err = await captureConnectRejection({});
    assert.equal(err.code, 'HDKIT_UPSTREAM_ERROR');
    assert.equal(err.coreHoursExhausted, true);
    assert.ok(err.remediation, 'expected remediation');
    assert.match(err.remediation.hint, /核心时长/);
    assert.ok(Array.isArray(err.remediation.steps));
  } finally {
    restore();
  }
});
