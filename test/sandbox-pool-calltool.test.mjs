import { test, mock } from 'node:test';
import assert from 'node:assert';

// callTool 级行为测试（S2/T3/T4/S4）：validate → hdkitConnect（真实实现 + fetch mock）→
// rememberWorkspacePool → enrich 全链路；终端层走 session-manager 模块 mock，不触真实 DevStation。

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
delete process.env.HW_POOL_TEMPLATE_PERSISTENT;

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
    exposeTunnel: async () => ({ ok: true, publicUrl: 'https://stub.example' }),
    renewTunnel: async () => ({ ok: true, renewedForHours: 720 }),
    installKeepaliveWatchdog: async () => ({ ok: true, pid: '123' }),
    getCurrentWorkspaceId: () => currentWs,
    setWorkspaceId: (id) => {
      currentWs = id;
    },
  },
});

const { callTool } = await import('../plugins/huaweicloud-core/src/tools.mjs');

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

test('callTool connect: capacity-insufficient remediation survives the MCP boundary', async () => {
  const restore = withFetchResponse(
    { code: 'HDKIT_CAPACITY_INSUFFICIENT', message: 'devkit提供的免费资源紧张，建议错峰使用' },
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
  );
  try {
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'ephemeral' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_CAPACITY_INSUFFICIENT');
    assert.equal(result.retryAfter, '60');
    assert.match(result.remediation.hint, /平台池容量暂时不足/);
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

test('callTool connect: success path validates, connects, remembers pool, and broadcasts TTL', async () => {
  execLog.length = 0;
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
    },
    { status: 200 },
  );
  try {
    // 大小写归一化：EPHEMERAL → ephemeral（validatePoolType 链路）
    const result = await callTool('huaweicloud_sandbox_connect', { pool_type: 'EPHEMERAL' });
    assert.equal(result.pool_type, 'ephemeral');
    assert.equal(result.template_id, 'tpl-eph');
    assert.ok(result.pool, 'expected TTL broadcast block');
    assert.match(result.pool.ttl_hint, /30 分钟/);
    assert.match(result.pool.ttl_hint, /1 小时/);
    assert.equal(currentWs, 'dev-1');
    // 连接后的沙箱预清理命令确实下发（session-manager mock 记录）
    assert.ok(execLog.some((c) => String(c).includes('devbridge delete-all')));
  } finally {
    restore();
  }
});

test('callTool exec carries pool mode; close_session clears the pool cache (S4)', async () => {
  // 前置：connect 记录 dev-1 为 ephemeral 池
  const restore = withFetchResponse(
    {
      session_id: 'dev-1',
      dev_stage_id: 'dev-1',
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
    workspace_id: 'dev-1',
    command: 'echo hi',
  });
  assert.equal(execResult.stdout, 'STUB');
  assert.equal(execResult.exitCode, 0);
  assert.equal(execResult.poolMode, 'ephemeral');
  assert.match(execResult.persistenceHint, /非持久沙箱/);

  const closed = await callTool('huaweicloud_sandbox_close_session', { workspace_id: 'dev-1' });
  assert.equal(closed, 'ok');

  const after = await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  });
  assert.equal(after.poolMode, undefined, 'pool cache must be cleared on session close');
  assert.equal(after.persistenceHint, undefined);
});
