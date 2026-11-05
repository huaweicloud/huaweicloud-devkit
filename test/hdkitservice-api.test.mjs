import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

const { hdkitConnect, hdkitConnectWithRetry, hdkitVoucherStatus, hdkitVoucherClaim } =
  await import('../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs');
const { clearRuntimeCredentials } = await import('../plugins/huaweicloud-core/src/auth/credentials.mjs');

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

    const result = await hdkitVoucherStatus();
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_MISSING');
    // #1055 D3-C14: the hdkitservice surface reports the exact English
    // contract string instead of the Chinese messageZh guidance (#883).
    assert.equal(result.message, 'credentials not configured');
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
    const result = await hdkitVoucherClaim('some-domain');
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
    const result = await hdkitVoucherStatus();
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
    const result = await hdkitVoucherClaim('some-domain');
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
    const result = await hdkitVoucherStatus();
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_INTERNAL');
    assert.equal(result.remediation, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 两池：pool_type 透传与钉扎 ──

test('hdkitConnect passes pool_type through without template pinning by default', async () => {
  // T5 环境隔离：预删钉扎变量并保存宿主原值，结束恢复（宿主设了 HW_POOL_TEMPLATE_* 时本用例仍须成立）
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  const savedPer = process.env.HW_POOL_TEMPLATE_PERSISTENT;
  delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (_url, opts) => {
    capturedBody = opts.body;
    return new Response(
      JSON.stringify({ session_id: 's1', dev_stage_id: 'd1', pool_type: 'persistent', template_id: 'tplp' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const result = await hdkitConnect({ pool_type: 'persistent' });
    const body = JSON.parse(capturedBody);
    assert.equal(body.pool_type, 'persistent');
    assert.equal(body.template_id, undefined); // 未钉扎：模板由服务端权威映射
    assert.equal(result.pool_type, 'persistent');
  } finally {
    global.fetch = originalFetch;
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
    if (savedPer === undefined) delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
    else process.env.HW_POOL_TEMPLATE_PERSISTENT = savedPer;
  }
});

test('hdkitConnect attaches pinned template when HW_POOL_TEMPLATE_* is configured', async () => {
  // T5 环境隔离：保存宿主原值，结束恢复（而非无条件删除）
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  const originalFetch = global.fetch;
  process.env.HW_POOL_TEMPLATE_EPHEMERAL = 'pinned-eph-tpl';
  let capturedBody = null;
  global.fetch = async (_url, opts) => {
    capturedBody = opts.body;
    return new Response(JSON.stringify({ session_id: 's1', dev_stage_id: 'd1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await hdkitConnect({ pool_type: 'ephemeral' });
    const body = JSON.parse(capturedBody);
    assert.equal(body.pool_type, 'ephemeral');
    assert.equal(body.template_id, 'pinned-eph-tpl'); // 钉扎：附带映射模板（老服务端兼容）
  } finally {
    global.fetch = originalFetch;
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
  }
});

// ── T6 显式 template_id 优先于钉扎 ──

test('hdkitConnect keeps explicit template_id over pinned template', async () => {
  const savedEph = process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  process.env.HW_POOL_TEMPLATE_EPHEMERAL = 'pinned-eph-tpl';
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (_url, opts) => {
    capturedBody = opts.body;
    return new Response(JSON.stringify({ session_id: 's1', dev_stage_id: 'd1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await hdkitConnect({ pool_type: 'ephemeral', template_id: 'explicit-tpl' });
    const body = JSON.parse(capturedBody);
    assert.equal(body.template_id, 'explicit-tpl'); // 显式模板优先，钉扎不覆盖
    assert.equal(body.pool_type, 'ephemeral');
  } finally {
    global.fetch = originalFetch;
    if (savedEph === undefined) delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
    else process.env.HW_POOL_TEMPLATE_EPHEMERAL = savedEph;
  }
});

// ── 429 双错误码结构化处理 ──

test('HDKIT_QUOTA_EXCEEDED carries retryAfter and release-oriented remediation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 'HDKIT_QUOTA_EXCEEDED',
        message: '沙箱并发配额已满（每账号最多 5 台实例），请释放闲置沙箱后重试',
      }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
    );
  try {
    const err = await hdkitConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_QUOTA_EXCEEDED');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, '60');
    assert.ok(err.remediation, 'expected remediation');
    assert.match(err.remediation.hint, /配额已满/);
    assert.ok(Array.isArray(err.remediation.steps));
    assert.match(err.remediation.steps.join(' '), /复用/); // 引导复用/释放，而非重试
  } finally {
    global.fetch = originalFetch;
  }
});

test('HDKIT_CAPACITY_INSUFFICIENT passes the final server copy through untouched', async () => {
  const originalFetch = global.fetch;
  const finalCopy = 'DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！';
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_CAPACITY_INSUFFICIENT', message: finalCopy }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  try {
    const err = await hdkitConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_CAPACITY_INSUFFICIENT');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, '60');
    assert.match(err.message, new RegExp(finalCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(err.remediation, undefined, 'capacity copy must not be wrapped in remediation');
  } finally {
    global.fetch = originalFetch;
  }
});

test('HDKIT_VERSION_TOO_OLD carries client/min version and upgrade remediation', async () => {
  const originalFetch = global.fetch;
  const serverMessage =
    '插件版本过旧，请升级至正式版 1.1.13 及以上。请升级插件：npx --yes huaweicloud-devkit@latest update --target <agent> 后重启会话';
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 'HDKIT_VERSION_TOO_OLD',
        message: serverMessage,
        clientVersion: '1.1.12',
        minVersion: '1.1.13',
        traceId: 'trace-v',
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const err = await hdkitConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(err.status, 409);
    assert.equal(err.clientVersion, '1.1.12');
    assert.equal(err.minVersion, '1.1.13');
    assert.match(err.message, /正式版 1\.1\.13/);
    assert.ok(err.remediation, 'expected structured remediation');
    assert.match(err.remediation.hint, /1\.1\.13/);
    assert.match(err.remediation.steps.join(' '), /npx --yes huaweicloud-devkit@latest update/);
    assert.match(err.remediation.steps.join(' '), /重启/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('hdkitConnectWithRetry retries gateway 504/502 and reuses the eventual success', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('<html>504 Gateway Time-out</html>', {
        status: 504,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (calls === 2) {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(JSON.stringify({ session_id: 's1', dev_stage_id: 'd1', pool_type: 'ephemeral' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await hdkitConnectWithRetry({ pool_type: 'ephemeral' }, { delaysMs: [0, 0] });
    assert.equal(result.session_id, 's1');
    assert.equal(calls, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('hdkitConnectWithRetry does not retry business errors', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 'HDKIT_QUOTA_EXCEEDED', message: 'quota' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  };
  try {
    const err = await hdkitConnectWithRetry({}, { delaysMs: [0, 0] }).then(
      () => null,
      (error) => error,
    );
    assert.equal(err.code, 'HDKIT_QUOTA_EXCEEDED');
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('hdkitConnectWithRetry exhausts retries and reports connectRetries', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('<html>504 Gateway Time-out</html>', {
      status: 504,
      headers: { 'Content-Type': 'text/html' },
    });
  };
  try {
    const err = await hdkitConnectWithRetry({}, { delaysMs: [0] }).then(
      () => null,
      (error) => error,
    );
    assert.match(err.message, /504/);
    assert.equal(err.connectRetries, 1);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 烧核播报（HD.97520422 消息内识别）──

test('core-hours exhausted upstream code surfaces friendly remediation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 'HDKIT_UPSTREAM_ERROR',
        message:
          '沙箱编排上游调用失败: GET /open-api-public/v2/devenvs upstream error HD.97520422: The remaining core hours has been used up',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const err = await hdkitConnect({}).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_UPSTREAM_ERROR');
    assert.equal(err.coreHoursExhausted, true);
    assert.match(err.remediation.hint, /核心时长/);
    assert.ok(Array.isArray(err.remediation.steps));
  } finally {
    global.fetch = originalFetch;
  }
});
