import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';
import { withApprovalMode } from './approval-mode-harness.ts';
import { elicitingSeam } from './eliciting-seam.ts';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
// 连接重试表针脚置 0：本文件的烧核用例伪造 HTTP 502 JSON，但 round 29 起烧核
// 裁决不重试（实测默认表下 1 fetch / 47ms），今天不置 0 也不会慢；保留针脚是
// 为了让将来落进本文件的瞬时重试用例不必睡满默认 30s+45s 表。
process.env.HW_SANDBOX_CONNECT_RETRY_DELAYS_MS = '0';
// 池缓存落盘路径隔离（fixtureDir 注册，进程退出回收）
process.env.HW_SANDBOX_POOL_CACHE_PATH = join(fixtureDir('sandbox-pool-calltool'), 'sandbox-pools.json');
// PR-3a: connect/renew/watchdog ride the approval gate. This tier pins
// DEVKIT_APPROVAL_MODE=ask for the whole file: every gated call answers the
// injected accept-form seam (a direct callTool caller cannot play the
// terminal half), and the benign classified exec pass-throughs stay
// ungated. The approval battery owns the gate's own contract.
process.env.DEVKIT_APPROVAL_MODE = 'ask';
delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
delete process.env.HW_POOL_TEMPLATE_PERSISTENT;

// callTool 级行为测试：validate → hdkitConnect（真实实现 + fetch mock）→ 播报判定 →
// rememberWorkspacePool 全链路；终端层走 session-manager 模块 mock，不触真实 DevStation。
const restoreFetchEnv = isolateDirectFetchEnv();
after(() => {
  restoreFetchEnv();
});

let currentWs: string | null = null;
const execLog: string[] = [];
// 3bfc1f53 形态：closeSession 记录入参——仅 session_id 的关机用例要断言
// 终端会话以服务端回传的 devStageId 关闭，而非 session_id 字符串。
const closeLog: Array<{ ws: unknown; username: unknown }> = [];

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
    closeSession: async (ws: unknown, username: unknown) => {
      closeLog.push({ ws, username });
      return true;
    },
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

// 隧道层 mock：renew_tunnel/keepalive_watchdog/expose_tunnel 走 devbridge-tunnel 面；
// dev 的 mock 面携带同名 stub（renewTunnel/installKeepaliveWatchdog/exposeTunnel）。
// connect 的隧道清理走 cleanupDevbridgeTunnels（选择性清理，dev 291ce371 同型）：
// 记录入 execLog 以断言「清理确实下发 + 不再全局 delete-all」。
mock.module('../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts', {
  namedExports: {
    exposeTunnel: async () => ({ ok: true, publicUrl: 'https://stub.example' }),
    renewTunnel: async () => ({ ok: true, renewedForHours: 720 }),
    installKeepaliveWatchdog: async () => ({ ok: true, pid: '123' }),
    cleanupDevbridgeTunnels: async (ws: string, opts: Record<string, unknown>) => {
      execLog.push(`${ws}:cleanup:${JSON.stringify(opts || {})}`);
      return { ok: true, deleteIds: [], killPids: [] };
    },
    validateTunnelId: () => {},
  },
});

const { callTool } = await import('../plugins/huaweicloud-core/src/tools.ts');
const { forgetWorkspacePool, poolContextFor } =
  await import('../plugins/huaweicloud-core/src/lib/hdkit/sandbox-pool.ts');

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
  ok?: boolean;
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
    // PR-3a: connect rides the approval gate. These pool-cache preloads are
    // the direct-callTool test tier's equivalents of a user-approved call —
    // token mode with the attestation and no token would mint; ask mode
    // would confirm. Pinning ask mode keeps the gate engaged (a pass-through
    // registration change would still fail these tests loudly) while never
    // needing a terminal half the harness cannot play here.
    await withApprovalMode('ask', async () => {
      const seam = elicitingSeam({ decision: 'accept', content: { confirm: true } });
      await callTool(
        'huaweicloud_sandbox_connect',
        { vendorConfirmed: VENDOR, pool_type: 'ephemeral' },
        {
          sessionId: `pool-preload-${(poolPreloadSeq += 1)}`,
          elicitation: seam.seam,
        },
      );
    });
  } finally {
    restore();
  }
}

// The pool-cache test tier's ask-mode pin (see connectEphemeralDev1's note)
// and the accept-answer seam every gated connect rides here.
let poolPreloadSeq = 0;

// One gated connect call through the ask-mode accept seam, the shape every
// connect case in this file shares.
async function gatedConnectCall(args: Record<string, unknown>, label: string): Promise<unknown> {
  return withApprovalMode('ask', async () =>
    callTool(
      'huaweicloud_sandbox_connect',
      { vendorConfirmed: VENDOR, ...args },
      {
        sessionId: `${label}-${(poolPreloadSeq += 1)}`,
        elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
      },
    ),
  );
}

test('callTool connect: invalid pool_type returns structured guidance instead of a bare -32603 throw', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not be reached');
  };
  try {
    let result: unknown;
    await withApprovalMode('ask', async () => {
      const seam = elicitingSeam({ decision: 'accept', content: { confirm: true } });
      result = await callTool(
        'huaweicloud_sandbox_connect',
        { vendorConfirmed: VENDOR, pool_type: 'weird' },
        { sessionId: `pool-invalid-${(poolPreloadSeq += 1)}`, elicitation: seam.seam },
      );
    });
    const failure = result as unknown as StructuredFailure;
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'HDKIT_INVALID_POOL_TYPE');
    assert.match(failure.message, /invalid pool_type/);
    assert.equal(fetchCalls, 0, 'invalid pool_type must fail locally, before any request');
  } finally {
    global.fetch = originalFetch;
  }
});

// 429 三码结构化用例共用：stub 429 Retry-After 信封，connect(ephemeral) 走结构化返回
async function connect429Structured(payload: unknown): Promise<StructuredFailure> {
  const restore = withFetchResponse(payload, {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  });
  try {
    return (await withApprovalMode('ask', async () =>
      callTool(
        'huaweicloud_sandbox_connect',
        { vendorConfirmed: VENDOR, pool_type: 'ephemeral' },
        {
          sessionId: `pool-429-${(poolPreloadSeq += 1)}`,
          elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
        },
      ),
    )) as unknown as StructuredFailure;
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

test('callTool connect: capacity-insufficient shows exactly the server message (no extra remediation)', async () => {
  const finalCopy = 'DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！';
  const result = await connect429Structured({
    code: 'HDKIT_CAPACITY_INSUFFICIENT',
    message: finalCopy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_CAPACITY_INSUFFICIENT');
  assert.equal(result.message, finalCopy);
  assert.equal(result.remediation, undefined, 'capacity copy must not be wrapped in remediation');
  assert.equal(result.retryAfter, '60');
});

test('callTool connect: template-quota-exceeded returns a structured envelope with remediation and no retryAfter', async () => {
  const finalCopy = '当前账号在此类型沙箱的运行中实例已达上限，无法创建新的沙箱';
  const result = await connect429Structured({
    code: 'HDKIT_TEMPLATE_QUOTA_EXCEEDED',
    message: finalCopy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HDKIT_TEMPLATE_QUOTA_EXCEEDED');
  assert.equal(result.message, finalCopy);
  assert.equal(result.retryAfter, undefined, 'template quota has no Retry-After');
  assert.ok(result.remediation, 'remediation must reach the tool result (lost on throw path)');
  assert.match(result.remediation!.hint, /上限/);
  assert.match(result.remediation!.steps.join(' '), /huaweicloud_sandbox_shutdown/);
  // MCP 边界等价：JSON-RPC 出口会整体序列化 result——字段必须可序列化不丢
  const json = JSON.parse(JSON.stringify(result)) as StructuredFailure;
  assert.equal(json.remediation?.hint, result.remediation!.hint);
  assert.equal(json.retryAfter, undefined);
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
    const result = (await withApprovalMode('ask', async () =>
      callTool(
        'huaweicloud_sandbox_connect',
        { vendorConfirmed: VENDOR },
        {
          sessionId: `pool-corehours-${(poolPreloadSeq += 1)}`,
          elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
        },
      ),
    )) as unknown as StructuredFailure;
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
    await withApprovalMode('ask', async () =>
      assert.rejects(
        callTool(
          'huaweicloud_sandbox_connect',
          { vendorConfirmed: VENDOR },
          {
            sessionId: `pool-internal-${(poolPreloadSeq += 1)}`,
            elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
          },
        ),
        /HDKIT_INTERNAL/,
      ),
    );
  } finally {
    restore();
  }
});

test('callTool connect: first connect broadcasts server-configured lifecycle', async () => {
  execLog.length = 0;
  forgetWorkspacePool();
  const restore = withFetchResponse(
    {
      ...CONNECTED_EPHEMERAL,
      pool_idle_shutdown_minutes: 45,
      pool_idle_delete_minutes: 120,
      started: false,
    },
    { status: 200 },
  );
  try {
    // 大小写归一化：EPHEMERAL → ephemeral（validatePoolType 链路）
    const result = (await gatedConnectCall({ pool_type: 'EPHEMERAL' }, 'pool-broadcast')) as ConnectResult;
    assert.equal(result.pool_type, 'ephemeral');
    assert.equal(result.template_id, 'tpl-eph');
    assert.ok(result.pool, 'expected TTL broadcast block');
    assert.match(result.pool.ttl_hint, /45 分钟自动关机/);
    assert.match(result.pool.ttl_hint, /2 小时自动删除/);
    assert.equal(currentWs, 'dev-1');
    // 连接后执行选择性清理（不再使用全局 delete-all，dev 291ce371/43fa459e 同型）：
    // 只清孤儿记录/宿主，保留其他端口、其他会话与 keepalive 保护的隧道。
    assert.ok(execLog.some((c) => c.startsWith('dev-1:cleanup:')));
    assert.ok(execLog.includes('dev-1:cleanup:{"mode":"stale"}'));
    assert.ok(!execLog.some((c) => c.includes('devbridge delete-all')));
    // 生命周期口径进入缓存（expose_tunnel 后续使用）
    assert.equal(poolContextFor('dev-1')?.poolLifecycle.idleShutdownMinutes, 45);
  } finally {
    restore();
  }
});

test('callTool connect: reuse is silent, wake-up re-announces, camelCase echo still caches', async () => {
  forgetWorkspacePool();
  const payload = (started: boolean) => ({
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
    const first = (await gatedConnectCall({ pool_type: 'ephemeral' }, 'pool-reuse-first')) as ConnectResult;
    assert.ok(first.pool, 'first connect must broadcast');
    assert.equal(poolContextFor('dev-reuse')?.poolMode, 'ephemeral');
  } finally {
    restore();
  }

  restore = withFetchResponse(payload(false), { status: 200 });
  try {
    const second = (await gatedConnectCall({ pool_type: 'ephemeral' }, 'pool-reuse-second')) as ConnectResult;
    assert.equal(second.pool, undefined, 'silent reuse must not repeat the lifecycle hint');
  } finally {
    restore();
  }

  restore = withFetchResponse(payload(true), { status: 200 });
  try {
    const woken = (await gatedConnectCall({ pool_type: 'ephemeral' }, 'pool-woken')) as ConnectResult;
    assert.ok(woken.pool, 'wake-up (started=true) must re-announce lifecycle');
  } finally {
    restore();
  }
});

test('callTool exec stays clean; close_session clears the pool cache', async () => {
  forgetWorkspacePool();
  await connectEphemeralDev1();

  // Benign content: the classified exec pass-through runs with no
  // confirmation surface (pinned in the approval battery; here it just
  // needs to reach the handler).
  const execResult = (await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  })) as ExecResult;
  assert.equal(execResult.stdout, 'STUB');
  assert.equal(execResult.exitCode, 0);
  // 逐次调用不刷池提示（提示只在 connect / expose_tunnel 出现）
  assert.equal(execResult.poolMode, undefined);
  assert.equal(execResult.persistenceHint, undefined);

  const closed = await callTool('huaweicloud_sandbox_close_session', { workspace_id: 'dev-1' });
  assert.equal(closed, 'ok');
  assert.equal(poolContextFor('dev-1'), undefined, 'pool cache must be cleared on session close');

  const after = (await callTool('huaweicloud_sandbox_exec_one_shot', {
    workspace_id: 'dev-1',
    command: 'echo hi',
  })) as ExecResult;
  assert.equal(after.poolMode, undefined);
  assert.equal(after.persistenceHint, undefined);
});

// 新教义（dev 5c09d225）：renew/watchdog 不再带池上下文——Unit C 的 v2-authored
// 「带池上下文」断言随 withPoolContext 拆除一并翻转（只拆不删，钉住静默面）。
test('callTool renew_tunnel and keepalive_watchdog stay clean (no per-call pool context)', async () => {
  forgetWorkspacePool();
  await connectEphemeralDev1();

  // The always-flavor tunnel faces confirm per call in ask mode (the gate
  // is the subject of the approval battery; these calls just need to reach
  // the handlers).
  await withApprovalMode('ask', async () => {
    const renewed = (await callTool(
      'huaweicloud_sandbox_renew_tunnel',
      { workspace_id: 'dev-1', tunnel_id: 't-1' },
      {
        sessionId: `pool-renew-${(poolPreloadSeq += 1)}`,
        elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
      },
    )) as ExecResult;
    assert.equal(renewed.ok, true);
    assert.equal(renewed.poolMode, undefined);
    assert.equal(renewed.persistenceHint, undefined);

    const watched = (await callTool(
      'huaweicloud_sandbox_keepalive_watchdog',
      { workspace_id: 'dev-1', tunnels: [{ tunnel_id: 't-1', url: 'https://stub.example' }] },
      {
        sessionId: `pool-watchdog-${(poolPreloadSeq += 1)}`,
        elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
      },
    )) as ExecResult;
    assert.equal(watched.ok, true);
    assert.equal(watched.poolMode, undefined);
    assert.equal(watched.persistenceHint, undefined);
  });
});

// ── callTool shutdown（dev 5d89c880 + 3bfc1f53 终态；写类工具走审批门）──

interface ShutdownResult {
  ok?: boolean;
  code?: string;
  message?: string;
  devStageId?: string;
  status?: string;
}

// 关机是门面工具：与 connect 同型，ask 姿态 + 接受表单缝（本文件的直调
// 层无法扮演终端半边）。
async function gatedShutdownCall(args: Record<string, unknown>, label: string): Promise<unknown> {
  return withApprovalMode('ask', async () =>
    callTool('huaweicloud_sandbox_shutdown', args, {
      sessionId: `${label}-${(poolPreloadSeq += 1)}`,
      elicitation: elicitingSeam({ decision: 'accept', content: { confirm: true } }).seam,
    }),
  );
}

test('callTool shutdown: closes via hdkitservice and returns status', async () => {
  const restore = withFetchResponse(
    { devStageId: 'ws1', status: 'shutting_down', message: '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒' },
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = (await gatedShutdownCall({ dev_stage_id: 'ws1' }, 'pool-shutdown')) as ShutdownResult;
    assert.equal(result.ok, true);
    assert.equal(result.devStageId, 'ws1');
    assert.equal(result.status, 'shutting_down');
    assert.equal(result.message, '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒');
  } finally {
    restore();
  }
});

test('callTool shutdown: not-found returns structured code', async () => {
  const restore = withFetchResponse(
    { code: 'HDKIT_SANDBOX_NOT_FOUND', message: '环境不存在或已被删除' },
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = (await gatedShutdownCall({ dev_stage_id: 'ws1' }, 'pool-shutdown-404')) as ShutdownResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_SANDBOX_NOT_FOUND');
    assert.match(result.message ?? '', /环境不存在或已被删除/);
  } finally {
    restore();
  }
});

test('callTool shutdown: session_id-only closes the returned workspace session', async () => {
  const previousWs = currentWs;
  currentWs = 'current-ws';
  closeLog.length = 0;
  const restore = withFetchResponse(
    {
      devStageId: 'ws-session',
      status: 'shutting_down',
      message: '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒',
    },
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = (await gatedShutdownCall({ session_id: 'sess-1' }, 'pool-shutdown-sess')) as ShutdownResult;
    assert.equal(result.ok, true);
    // 3bfc1f53：仅 session_id 时 closeSession 以服务端回传的 devStageId 为准
    //（此前的 devStageId || sessionId 拼法把 session_id 字符串当 workspace 用）
    assert.deepEqual(closeLog.at(-1), { ws: 'ws-session', username: 'root' });
  } finally {
    restore();
    currentWs = previousWs;
  }
});

test('callTool shutdown: an empty devStageId echo falls through to the workspace chain (dev || semantics)', async () => {
  const previousWs = currentWs;
  currentWs = 'current-ws';
  closeLog.length = 0;
  const restore = withFetchResponse(
    {
      // 敌意/异常服务端回显空串：|| 链穿透到当前 workspace（interrogate
      // port-pr6 F4 的回归钉——?? 链会让 closeSession 收到 '' 白跑一趟）
      devStageId: '',
      status: 'shutting_down',
      message: '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒',
    },
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = (await gatedShutdownCall({ session_id: 'sess-1' }, 'pool-shutdown-empty')) as ShutdownResult;
    assert.equal(result.ok, true);
    assert.deepEqual(closeLog.at(-1), { ws: 'current-ws', username: 'root' });
  } finally {
    restore();
    currentWs = previousWs;
  }
});

test('callTool shutdown: workspace_id-only closes that workspace session', async () => {
  const previousWs = currentWs;
  currentWs = null;
  closeLog.length = 0;
  const restore = withFetchResponse(
    {
      devStageId: 'ws-fallback',
      status: 'shutting_down',
      message: '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒',
    },
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const result = (await gatedShutdownCall({ workspace_id: 'ws-fallback' }, 'pool-shutdown-ws')) as ShutdownResult;
    assert.equal(result.ok, true);
    assert.deepEqual(closeLog.at(-1), { ws: 'ws-fallback', username: 'root' });
  } finally {
    restore();
    currentWs = previousWs;
  }
});

test('callTool shutdown: no id and no current workspace returns structured guidance', async () => {
  const previousWs = currentWs;
  currentWs = null;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not be reached');
  };
  try {
    const result = (await gatedShutdownCall({}, 'pool-shutdown-noid')) as ShutdownResult;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HDKIT_INVALID_REQUEST');
    assert.match(result.message ?? '', /session_id or dev_stage_id is required/);
    assert.equal(fetchCalls, 0, 'an id-less call must fail locally, before any request');
  } finally {
    global.fetch = originalFetch;
    currentWs = previousWs;
  }
});
