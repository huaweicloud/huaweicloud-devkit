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

test('callTool connect: invalid pool_type errors locally without any request', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not be reached');
  };
  try {
    await assert.rejects(
      callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'weird' }),
      /invalid pool_type/,
    );
    assert.equal(fetchCalls, 0, 'invalid pool_type must fail locally, before any request');
  } finally {
    global.fetch = originalFetch;
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

test('callTool exec carries the pool mode recorded at connect (S4 exec half)', async () => {
  // 前置：connect 记录 dev-1 为 ephemeral 池
  const restore = withFetchResponse(CONNECTED_EPHEMERAL, { status: 200 });
  try {
    await callTool('huaweicloud_sandbox_connect', { vendorConfirmed: VENDOR, pool_type: 'ephemeral' });
  } finally {
    restore();
  }

  const execResult = (await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  })) as ExecResult;
  assert.equal(execResult.stdout, 'STUB');
  assert.equal(execResult.exitCode, 0);
  assert.equal(execResult.poolMode, 'ephemeral');
  assert.match(execResult.persistenceHint ?? '', /非持久沙箱/);
});
