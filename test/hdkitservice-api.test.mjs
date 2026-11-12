import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
// A 409 HDKIT_VERSION_TOO_OLD response triggers maybeAutoUpgrade inside
// hdkitRequest. Without this flag a non-CI dev machine would spawn a REAL
// detached runner executing `npx update --target all` (same masking as
// mcp-server.test.mjs / plugins-e2e.test.mjs).
process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';

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

// ── 两池：pool_type 透传（不再支持 template_id/钉扎）──

test('hdkitConnect passes pool_type through and never sends template_id', async () => {
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
    const result = await hdkitConnect({ pool_type: 'persistent', template_id: 'legacy-tpl' });
    const body = JSON.parse(capturedBody);
    assert.equal(body.pool_type, 'persistent');
    assert.equal(body.template_id, undefined); // 自定义模板已下线：即使调用方传入也不上送
    assert.equal(result.pool_type, 'persistent');
  } finally {
    global.fetch = originalFetch;
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

test('HDKIT_TEMPLATE_QUOTA_EXCEEDED passes the final server copy through untouched', async () => {
  const originalFetch = global.fetch;
  const finalCopy = '当前账号在此类型沙箱的运行中实例已达上限，无法创建新的沙箱';
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_TEMPLATE_QUOTA_EXCEEDED', message: finalCopy }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const err = await hdkitConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_TEMPLATE_QUOTA_EXCEEDED');
    assert.equal(err.status, 429);
    assert.equal(err.message, finalCopy);
    assert.equal(err.retryAfter, undefined, 'template quota has no Retry-After');
    assert.equal(err.remediation, undefined, 'template quota copy must not be wrapped in remediation');
  } finally {
    global.fetch = originalFetch;
  }
});

test('HDKIT_TEMPLATE_QUOTA_EXCEEDED falls back to the final copy when server message is empty', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_TEMPLATE_QUOTA_EXCEEDED' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const err = await hdkitConnect({ pool_type: 'ephemeral' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_TEMPLATE_QUOTA_EXCEEDED');
    assert.equal(err.message, '当前账号在此类型沙箱的运行中实例已达上限，无法创建新的沙箱');
    assert.doesNotMatch(err.message, /^HDKIT_TEMPLATE_QUOTA_EXCEEDED:/);
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
    assert.ok(err.autoUpgrade, 'expected autoUpgrade status');
    assert.equal(err.autoUpgrade.status, 'disabled');
    assert.equal(err.autoUpgrade.reason, 'skip_update');
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
