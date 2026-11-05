import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
delete process.env.HW_POOL_TEMPLATE_PERSISTENT;

// callTool 级行为测试：validate → hdkitConnect（真实实现 + fetch mock）→
// rememberWorkspacePool → enrich 全链路；终端层走 session-manager 模块 mock，
// 不触真实 DevStation。
const restoreFetchEnv = isolateDirectFetchEnv();
after(() => {
  restoreFetchEnv();
});

let currentWs: string | null = null;
const execLog: string[] = [];

// 模块 mock 必须先于 tools.ts 导入注册（按解析后 URL 拦截嵌套 import）
mock.module('../plugins/huaweicloud-core/src/sandbox/session-manager.ts', {
  namedExports: {
    execOneShot: async (ws: string, cmd: string) => {
      execLog.push(`${ws}:${cmd}`);
      return { stdout: 'STUB', exitCode: 0 };
    },
    execWithSession: async (ws: string, cmd: string) => {
      execLog.push(`${ws}:${cmd}`);
      return { stdout: 'STUB', exitCode: 0 };
    },
    closeSession: async () => true,
    uploadFileWithSession: async () => ({ ok: true, remote_path: 'stub' }),
    uploadProjectWithSession: async () => ({ ok: true }),
    deployNginx: async () => ({ ok: true, port: 8080 }),
    deployCheck: async () => ({ ok: true, complete: true }),
    getCurrentWorkspaceId: () => currentWs,
    setWorkspaceId: (id: string | null) => {
      currentWs = id;
    },
  },
});

// 隧道层 mock：805f24ba 把 renew_tunnel/keepalive_watchdog 也包进 withPoolContext；
// dev 的 mock 面携带同名 stub（renewTunnel/installKeepaliveWatchdog/exposeTunnel）。
mock.module('../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts', {
  namedExports: {
    exposeTunnel: async () => ({ ok: true, publicUrl: 'https://stub.example' }),
    renewTunnel: async () => ({ ok: true, renewedForHours: 720 }),
    installKeepaliveWatchdog: async () => ({ ok: true, pid: '123' }),
    validateTunnelId: () => {},
  },
});

const { callTool } = await import('../plugins/huaweicloud-core/src/tools.ts');

function withFetchResponse(payload: unknown, init: ResponseInit = {}) {
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

const VENDOR = 'test: vendor established by the harness';

interface ConnectResult {
  pool_type?: string;
  template_id?: string;
  pool?: { pool_type: string; ttl_hint: string };
}

interface ExecResult {
  stdout?: string;
  exitCode?: number;
  poolMode?: string;
  persistenceHint?: string;
}

// 805f24ba 结构化失败信封：业务预期失败与非法 pool_type 不再抛出（MCP 错误
// 信封只携带 code+message，指引字段在 throw 路径会丢失）
interface StructuredFailure {
  ok: false;
  code: string;
  message: string;
  retryAfter?: string;
  coreHoursExhausted?: boolean;
  remediation?: { hint: string; steps: string[] };
}

const CONNECTED_EPHEMERAL = {
  session_id: 'dev-1',
  dev_stage_id: 'dev-1',
  connection_id: '42',
  connection_address: 'wss://stub',
  status: 'connected',
  expiresAt: '2026-11-03T00:00:00Z',
  pool_type: 'ephemeral',
  template_id: 'tpl-eph',
};

// 前置：connect 记录 dev-1 为 ephemeral 池（S4 清池与 renew/watchdog 池上下文用例共用）
async function connectEphemeralDev1(): Promise<void> {
  const restore = withFetchResponse(CONNECTED_EPHEMERAL, { status: 200 });
  try {
    await callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'ephemeral' });
  } finally {
    restore();
  }
}

test('callTool connect: invalid pool_type returns structured guidance instead of a bare -32603 throw', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not be reached');
  };
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'weird',
    })) as unknown as StructuredFailure;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_INVALID_POOL_TYPE');
    assert.match(result.message, /invalid pool_type/);
    assert.equal(fetchCalls, 0, 'invalid pool_type must fail locally, before any request');
  } finally {
    global.fetch = originalFetch;
  }
});

// 429 双码结构化用例共用：stub 429 Retry-After 信封，connect(ephemeral) 走结构化返回
async function connect429Structured(payload: unknown): Promise<StructuredFailure> {
  const restore = withFetchResponse(payload, {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  });
  try {
    return (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as unknown as StructuredFailure;
  } finally {
    restore();
  }
}

test('callTool connect: 429 quota-exceeded remediation survives the MCP boundary', async () => {
  const result = await connect429Structured({
    code: 'HDKIT_QUOTA_EXCEEDED',
    message: '沙箱并发配额已满（每账号最多 5 台实例），请释放闲置沙箱后重试',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_QUOTA_EXCEEDED');
  assert.equal(result.retryAfter, '60');
  assert.ok(result.remediation, 'remediation must reach the tool result (lost on throw path)');
  assert.match(result.remediation.hint, /配额已满/);
  assert.ok(Array.isArray(result.remediation.steps));
  // MCP 边界等价：JSON-RPC 出口会整体序列化 result——字段必须可序列化不丢
  const json = JSON.parse(JSON.stringify(result)) as StructuredFailure;
  assert.equal(json.remediation?.hint, result.remediation.hint);
  assert.equal(json.retryAfter, '60');
});

test('callTool connect: capacity-insufficient remediation survives the MCP boundary', async () => {
  const result = await connect429Structured({
    code: 'HDKIT_CAPACITY_INSUFFICIENT',
    message: 'devkit提供的免费资源紧张，建议错峰使用',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_CAPACITY_INSUFFICIENT');
  assert.equal(result.retryAfter, '60');
  assert.match(result.remediation?.hint ?? '', /平台池容量暂时不足/);
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
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
    })) as unknown as StructuredFailure;
    assert.equal(result.ok, false);
    assert.equal(result.coreHoursExhausted, true);
    assert.match(result.remediation?.hint ?? '', /核心时长/);
  } finally {
    restore();
  }
});

test('callTool connect: unexpected server errors keep the throw path (rethrow passthrough, v2-authored)', async () => {
  const restore = withFetchResponse({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }, { status: 500 });
  try {
    await assert.rejects(callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR }), /HDKIT_INTERNAL/);
  } finally {
    restore();
  }
});

test('callTool connect: success path validates, connects, remembers pool, and broadcasts TTL', async () => {
  execLog.length = 0;
  const restore = withFetchResponse(CONNECTED_EPHEMERAL, { status: 200 });
  try {
    // 大小写归一化：EPHEMERAL → ephemeral（validatePoolType 链路）
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'EPHEMERAL',
    })) as ConnectResult;
    assert.equal(result.pool_type, 'ephemeral');
    assert.equal(result.template_id, 'tpl-eph');
    assert.ok(result.pool, 'expected TTL broadcast block');
    assert.match(result.pool.ttl_hint, /30 分钟/);
    assert.match(result.pool.ttl_hint, /1 小时/);
    assert.equal(currentWs, 'dev-1');
    // 连接后的沙箱预清理命令确实下发（session-manager mock 记录）
    assert.ok(execLog.some((c) => c.includes('devbridge delete-all')));
  } finally {
    restore();
  }
});

test('callTool connect: camelCase poolType echo still populates the pool cache (wire naming drift guard)', async () => {
  const restore = withFetchResponse(
    {
      session_id: 'dev-cc',
      dev_stage_id: 'dev-cc',
      connection_id: '42',
      connection_address: 'wss://stub',
      status: 'connected',
      poolType: 'ephemeral',
      templateId: 'tpl-eph',
    },
    { status: 200 },
  );
  try {
    const result = (await callTool('huaweicloud_sandbox_connect', {
      vendorConfirmed: VENDOR,
      pool_type: 'ephemeral',
    })) as ConnectResult;
    assert.ok(result.pool, 'camelCase echo must still broadcast lifecycle');
    assert.equal(result.pool.pool_type, 'ephemeral');
    // 池缓存同样双读兜底：exec 返回值仍带 poolMode
    const execResult = (await callTool('huaweicloud_sandbox_exec_one_shot', {
      workspace_id: 'dev-cc',
      command: 'echo hi',
    })) as ExecResult;
    assert.equal(execResult.poolMode, 'ephemeral');
  } finally {
    restore();
  }
});

test('callTool exec carries pool mode; close_session clears the pool cache (S4)', async () => {
  await connectEphemeralDev1();

  const execResult = (await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  })) as ExecResult;
  assert.equal(execResult.stdout, 'STUB');
  assert.equal(execResult.exitCode, 0);
  assert.equal(execResult.poolMode, 'ephemeral');
  assert.match(execResult.persistenceHint ?? '', /非持久沙箱/);

  const closed = await callTool('huaweicloud_sandbox_close_session', { workspace_id: 'dev-1' });
  assert.equal(closed, 'ok');

  const after = (await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  })) as ExecResult;
  assert.equal(after.poolMode, undefined, 'pool cache must be cleared on session close');
  assert.equal(after.persistenceHint, undefined);
});

test('callTool renew_tunnel and keepalive_watchdog carry the pool context (805f24ba wrap, v2-authored)', async () => {
  await connectEphemeralDev1();

  const renewed = (await callTool('huaweicloud_sandbox_renew_tunnel', {
    workspace_id: 'dev-1',
    tunnel_id: 't-1',
  })) as ExecResult;
  assert.equal(renewed.poolMode, 'ephemeral');
  assert.match(renewed.persistenceHint ?? '', /非持久沙箱/);

  const watched = (await callTool('huaweicloud_sandbox_keepalive_watchdog', {
    workspace_id: 'dev-1',
    tunnels: [{ tunnel_id: 't-1', url: 'https://stub.example' }],
  })) as ExecResult;
  assert.equal(watched.poolMode, 'ephemeral');
  assert.match(watched.persistenceHint ?? '', /非持久沙箱/);
});
