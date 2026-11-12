import { test, mock } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// callTool 级行为测试：validate → hdkitConnect（真实实现 + fetch mock）→ 播报判定 →
// rememberWorkspacePool 全链路；终端层走 session-manager 模块 mock，不触真实 DevStation。

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HW_SANDBOX_POOL_CACHE_PATH = join(tmpdir(), `hw-sandbox-calltool-test-${process.pid}.json`);
// 下方用例伪造 409 HDKIT_VERSION_TOO_OLD：必须屏蔽后台自动升级（R1，同 hdkitservice-api.test.mjs）。
process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';

let currentWs = null;
const execLog = [];

// 模块 mock 必须先于 tools.mjs 导入注册（按解析后 URL 拦截嵌套 import）
mock.module('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs', {
  namedExports: {
    execOneShot: async (ws, cmd) => {
      execLog.push(cmd);
      return { stdout: 'STUB', exitCode: 0 };
    },
    execWithSession: async (ws, cmd) => {
      execLog.push(cmd);
      return { stdout: 'STUB', exitCode: 0 };
    },
    closeSession: async () => true,
    uploadFileWithSession: async () => ({ ok: true, remote_path: 'stub' }),
    uploadProjectWithSession: async () => ({ ok: true }),
    deployNginx: async () => ({ ok: true, port: 8080 }),
    deployCheck: async () => ({ ok: true, complete: true }),
    // #981 review: tools.mjs imports these; a mocked module must expose every
    // named export the caller imports or the whole file fails to instantiate.
    shouldAutoRebind: () => false,
    applyAutoRebind: (checkResult) => checkResult,
    exposeTunnel: async () => ({ ok: true, publicUrl: 'https://stub.example' }),
    renewTunnel: async () => ({ ok: true, renewedForHours: 720 }),
    installKeepaliveWatchdog: async () => ({ ok: true, pid: '123' }),
    cleanupDevbridgeTunnels: async (ws, opts) => {
      execLog.push(`cleanup:${JSON.stringify(opts || {})}`);
      return { ok: true, deleteIds: [], killPids: [] };
    },
    getCurrentWorkspaceId: () => currentWs,
    setWorkspaceId: (id) => {
      currentWs = id;
    },
  },
});

const { callTool } = await import('../plugins/huaweicloud-core/src/tools.mjs');
const { forgetWorkspacePool, poolContextFor } =
  await import('../plugins/huaweicloud-core/src/sandbox/sandbox-pool.mjs');

function withFetchResponse(payload, init) {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  return () => {
    global.fetch = originalFetch;
  };
}

test('callTool connect: invalid pool_type returns structured guidance instead of a bare -32603 throw', async () => {
  const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'weird' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_INVALID_POOL_TYPE');
  assert.match(result.message, /invalid pool_type/);
});

test('callTool connect: legacy template_id is rejected and never sent', async () => {
  forgetWorkspacePool();
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await callTool('huaweicloud_sandbox_connect', {
      pool_type: 'ephemeral',
      template_id: 'legacy-tpl',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_INVALID_REQUEST');
    assert.match(result.message, /template_id 已不再支持/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callTool connect: 429 quota-exceeded remediation survives the MCP boundary', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_QUOTA_EXCEEDED',
      message: '沙箱并发配额已满（每账号最多 5 台实例），请释放闲置沙箱后重试',
    },
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_QUOTA_EXCEEDED');
    assert.equal(result.retryAfter, '60');
    assert.ok(result.remediation, 'remediation must reach the tool result (lost on throw path)');
    assert.match(result.remediation.hint, /配额已满/);
    assert.ok(Array.isArray(result.remediation.steps));
    // MCP 边界等价：JSON-RPC 出口会整体序列化 result——字段必须可序列化不丢
    const json = JSON.parse(JSON.stringify(result));
    assert.equal(json.remediation.hint, result.remediation.hint);
    assert.equal(json.retryAfter, '60');
  } finally {
    restore();
  }
});

test('callTool connect: capacity-insufficient shows exactly the server message (no extra remediation)', async () => {
  const finalCopy = 'DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！';
  const restore = withFetchResponse(
    { code: 'HDKIT_CAPACITY_INSUFFICIENT', message: finalCopy },
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_CAPACITY_INSUFFICIENT');
    assert.equal(result.message, finalCopy);
    assert.equal(result.remediation, undefined, 'capacity copy must not be wrapped in remediation');
    assert.equal(result.retryAfter, '60');
  } finally {
    restore();
  }
});

test('callTool connect: template-quota-exceeded returns structured copy without remediation or retryAfter', async () => {
  const finalCopy = '当前账号在此类型沙箱的运行中实例已达上限，无法创建新的沙箱';
  const restore = withFetchResponse(
    { code: 'HDKIT_TEMPLATE_QUOTA_EXCEEDED', message: finalCopy },
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_TEMPLATE_QUOTA_EXCEEDED');
    assert.equal(result.message, finalCopy);
    assert.equal(result.remediation, undefined, 'template quota copy must not be wrapped in remediation');
    assert.equal(result.retryAfter, undefined, 'template quota has no Retry-After');
  } finally {
    restore();
  }
});

test('callTool connect: version-too-old remediation survives the MCP boundary', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_VERSION_TOO_OLD',
      message: '插件版本过旧，请升级至正式版 1.1.13 及以上。',
      clientVersion: '1.1.12',
      minVersion: '1.1.13',
    },
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(result.clientVersion, '1.1.12');
    assert.equal(result.minVersion, '1.1.13');
    assert.ok(result.remediation, 'remediation must reach the tool result');
    assert.match(result.remediation.steps.join(' '), /huaweicloud-devkit@latest update/);
    const json = JSON.parse(JSON.stringify(result));
    assert.equal(json.remediation.hint, result.remediation.hint);
  } finally {
    restore();
  }
});

test('callTool check_user: version-too-old returns structured guidance', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_VERSION_TOO_OLD',
      message: '插件版本过旧，请升级至正式版 1.1.13 及以上。',
      clientVersion: '1.1.12',
      minVersion: '1.1.13',
    },
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_check_user', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(result.minVersion, '1.1.13');
    assert.ok(result.remediation);
  } finally {
    restore();
  }
});

test('callTool sign_agreement: version gate is structured, autoUpgrade survives (#1117)', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_VERSION_TOO_OLD',
      message: '插件版本过旧，请升级至正式版 1.1.13 及以上。',
      clientVersion: '1.1.12',
      minVersion: '1.1.13',
    },
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_sign_agreement', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(result.clientVersion, '1.1.12');
    assert.equal(result.minVersion, '1.1.13');
    assert.ok(result.remediation, 'remediation must reach the tool result');
    assert.ok(result.autoUpgrade, 'autoUpgrade must reach the tool result');
    assert.match(result.remediation.steps.join(' '), /update --target <agent>/);
  } finally {
    restore();
  }
});

test('callTool voucher_status: version gate passes autoUpgrade through (#1117)', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_VERSION_TOO_OLD',
      message: '插件版本过旧，请升级至正式版 1.1.13 及以上。',
      clientVersion: '1.1.12',
      minVersion: '1.1.13',
    },
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = await callTool('huaweicloud_voucher_status', {});
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_VERSION_TOO_OLD');
    assert.equal(result.clientVersion, '1.1.12');
    assert.equal(result.minVersion, '1.1.13');
    assert.ok(result.remediation);
    assert.ok(result.autoUpgrade, 'autoUpgrade must reach the tool result');
    assert.equal(result.autoUpgrade.status, 'disabled');
  } finally {
    restore();
  }
});

test('callTool connect: core-hours exhausted surfaces structured guidance', async () => {
  const restore = withFetchResponse(
    {
      code: 'HDKIT_UPSTREAM_ERROR',
      message: '沙箱编排上游调用失败: upstream error HD.97520422: The remaining core hours has been used up',
    },
    { status: 502 },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', {});
    assert.equal(result.ok, false);
    assert.equal(result.coreHoursExhausted, true);
    assert.match(result.remediation.hint, /核心时长/);
  } finally {
    restore();
  }
});

test('callTool connect: first connect broadcasts server-configured lifecycle', async () => {
  execLog.length = 0;
  forgetWorkspacePool();
  const restore = withFetchResponse(
    {
      session_id: 'dev-1',
      dev_stage_id: 'dev-1',
      connection_id: '42',
      connection_address: 'wss://stub',
      status: 'connected',
      expiresAt: '2026-11-03T00:00:00Z',
      pool_type: 'ephemeral',
      template_id: 'tpl-eph',
      pool_idle_shutdown_minutes: 45,
      pool_idle_delete_minutes: 120,
      started: false,
    },
    { status: 200 },
  );
  try {
    // 大小写归一化：EPHEMERAL → ephemeral（validatePoolType 链路）
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'EPHEMERAL' });
    assert.equal(result.pool_type, 'ephemeral');
    assert.equal(result.template_id, 'tpl-eph');
    assert.ok(result.pool, 'expected TTL broadcast block');
    assert.match(result.pool.ttl_hint, /45 分钟自动关机/);
    assert.match(result.pool.ttl_hint, /2 小时自动删除/);
    assert.equal(currentWs, 'dev-1');
    // 连接后执行选择性清理（不再使用全局 delete-all）
    assert.ok(execLog.some((c) => String(c).startsWith('cleanup:')));
    assert.ok(execLog.includes('cleanup:{"mode":"stale"}'));
    assert.ok(!execLog.some((c) => String(c).includes('devbridge delete-all')));
    // 生命周期口径进入缓存（expose_tunnel 后续使用）
    assert.equal(poolContextFor('dev-1').poolLifecycle.idleShutdownMinutes, 45);
  } finally {
    restore();
  }
});

test('callTool connect: reuse is silent, wake-up re-announces, camelCase echo still caches', async () => {
  forgetWorkspacePool();
  const payload = (started) => ({
    session_id: 'dev-reuse',
    dev_stage_id: 'dev-reuse',
    connection_id: '42',
    connection_address: 'wss://stub',
    status: 'connected',
    poolType: 'ephemeral',
    templateId: 'tpl-eph',
    started,
  });

  let restore = withFetchResponse(payload(false), { status: 200 });
  try {
    const first = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.ok(first.pool, 'first connect must broadcast');
    assert.equal(poolContextFor('dev-reuse').poolMode, 'ephemeral');
  } finally {
    restore();
  }

  restore = withFetchResponse(payload(false), { status: 200 });
  try {
    const second = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(second.pool, undefined, 'silent reuse must not repeat the lifecycle hint');
  } finally {
    restore();
  }

  restore = withFetchResponse(payload(true), { status: 200 });
  try {
    const woken = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.ok(woken.pool, 'wake-up (started=true) must re-announce lifecycle');
  } finally {
    restore();
  }
});

test('callTool exec stays clean; close_session clears the pool cache', async () => {
  forgetWorkspacePool();
  const restore = withFetchResponse(
    {
      session_id: 'dev-clean',
      dev_stage_id: 'dev-clean',
      connection_id: '42',
      connection_address: 'wss://stub',
      status: 'connected',
      pool_type: 'ephemeral',
      template_id: 'tpl-eph',
    },
    { status: 200 },
  );
  try {
    await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
  } finally {
    restore();
  }

  const execResult = await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-clean',
    command: 'echo hi',
  });
  assert.equal(execResult.stdout, 'STUB');
  assert.equal(execResult.exitCode, 0);
  // 逐次调用不刷池提示（提示只在 connect / expose_tunnel 出现）
  assert.equal(execResult.poolMode, undefined);
  assert.equal(execResult.persistenceHint, undefined);

  const closed = await callTool('huaweicloud_sandbox_close_session', { workspace_id: 'dev-clean' });
  assert.equal(closed, 'ok');
  assert.equal(poolContextFor('dev-clean'), undefined, 'pool cache must be cleared on session close');

  const after = await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-clean',
    command: 'echo hi',
  });
  assert.equal(after.poolMode, undefined);
  assert.equal(after.persistenceHint, undefined);
});
