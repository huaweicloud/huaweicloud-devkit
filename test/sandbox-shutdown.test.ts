import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateDirectFetchEnv } from './fetch-stub-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

// PR-6（dev 5d89c880 + 3bfc1f53 移植）的注册验收套件：hdkitShutdown API 面
// 与四面同步的注册钉。callTool 面（含 3bfc1f53 的仅 session_id 关终端会话
// 修复）钉在 test/sandbox-pool-calltool.test.ts；门电池的九工具循环在
// test/approval-sandbox.test.ts；核时提示的行为断言在 test/sandbox-pool.test.ts；
// 教义面在 test/structure-sandbox-resource-pool.test.ts——本文件只收 API 面
// 与注册面，两边都在红态可类型检查（API 用动态门面：类型化解构会在工具
// 尚不存在时打红 typecheck，遮蔽「测试红」与「编译红」的区分）。
process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
process.env.HW_SANDBOX_POOL_CACHE_PATH = join(fixtureDir('sandbox-shutdown'), 'sandbox-pools.json');

const restoreFetchEnv = isolateDirectFetchEnv();
after(() => {
  restoreFetchEnv();
});

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

// 红态门面：动态导入 + 属性访问，工具存在后（实现提交）改回类型化解构。
type ShutdownApi = (sessionId: unknown, devStageId: unknown) => Promise<Record<string, unknown>>;
const hdkitModule = (await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts')) as unknown as Record<
  string,
  unknown
>;
const hdkitShutdown = hdkitModule.hdkitShutdown as ShutdownApi | undefined;

test('hdkitShutdown is exported (dev 5d89c880)', () => {
  assert.equal(typeof hdkitShutdown, 'function', 'hdkitShutdown must be exported from hdkitservice-api');
});

test('hdkitShutdown posts shutdown and returns server status', async () => {
  assert.ok(hdkitShutdown, 'hdkitShutdown must exist');
  const originalFetch = global.fetch;
  let requestedUrl = '';
  let requestBody: Record<string, unknown> = {};
  global.fetch = (async (url: Parameters<typeof fetch>[0], opts: Parameters<typeof fetch>[1]) => {
    requestedUrl = String(url);
    requestBody = JSON.parse(String((opts as { body?: string }).body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        devStageId: 'ws1',
        status: 'shutting_down',
        message: '沙箱正在关机，实例与数据盘保留，下次连接会自动唤醒',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const result = await hdkitShutdown('s1', null);
    assert.match(requestedUrl, /\/shutdown$/);
    assert.deepEqual(requestBody, { session_id: 's1' });
    assert.equal(result.devStageId, 'ws1');
    assert.equal(result.status, 'shutting_down');
    assert.match(String(result.message), /正在关机/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('hdkitShutdown surfaces not-found code', async () => {
  assert.ok(hdkitShutdown, 'hdkitShutdown must exist');
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ code: 'HDKIT_SANDBOX_NOT_FOUND', message: '环境不存在或已被删除' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    const err = (await hdkitShutdown(null, 'ws1').then(
      () => null,
      (error: unknown) => error,
    )) as { code?: string; status?: number };
    assert.ok(err, 'expected rejection');
    assert.equal(err.code, 'HDKIT_SANDBOX_NOT_FOUND');
    assert.equal(err.status, 404);
  } finally {
    global.fetch = originalFetch;
  }
});

test('hdkitShutdown requires an id', async () => {
  assert.ok(hdkitShutdown, 'hdkitShutdown must exist');
  await assert.rejects(() => hdkitShutdown(undefined, undefined), /session_id or dev_stage_id is required/);
});

test('shutdown joins the approval roster with a structured payload shape', async () => {
  const { APPROVAL_TOOLS, APPROVAL_TOOL_INPUT_SHAPES } = await import(
    '../plugins/huaweicloud-core/src/approval-roster.ts'
  );
  assert.ok(
    (APPROVAL_TOOLS as readonly string[]).includes('huaweicloud_sandbox_shutdown'),
    'shutdown must join APPROVAL_TOOLS — an unrostered shutdown is a safety hole (工具在但审批不拦)',
  );
  assert.equal(
    (APPROVAL_TOOL_INPUT_SHAPES as Record<string, string>)['huaweicloud_sandbox_shutdown'],
    'structured',
    "shutdown's payload has no command surface — the hook exemption shape row must say structured",
  );
});

test('shutdown registers an always-flavor approval spec owned by the sandbox pack', async () => {
  const { APPROVAL_SPECS } = await import('../plugins/huaweicloud-core/src/packs/registry.ts');
  const spec = (APPROVAL_SPECS as Record<string, { flavor?: string; domain?: string }>)['huaweicloud_sandbox_shutdown'];
  assert.ok(spec, 'shutdown must carry an ApprovalSpec (the gate resolves specs by name)');
  assert.equal(spec.flavor, 'always', 'shutdown is irreversible — no content rule may exempt it');
  assert.equal(spec.domain, 'sandbox');
});

test('safety policy registers shutdown as a sandbox write tool (dev 5d89c880 hunk)', () => {
  const policy = JSON.parse(
    readFileSync(join(pluginRoot, 'safety', 'policy.json'), 'utf8'),
  ) as { sandboxWriteTools?: string[] };
  assert.ok(
    policy.sandboxWriteTools?.includes('huaweicloud_sandbox_shutdown'),
    'policy.json sandboxWriteTools must list shutdown',
  );
});

test('the e2e roster covers shutdown in the sandbox pack list', async () => {
  const { PER_PACK_TOOLS } = await import('./plugins-e2e-roster.ts');
  assert.ok(
    (PER_PACK_TOOLS as Record<string, readonly string[]>).sandbox.includes('huaweicloud_sandbox_shutdown'),
    'the plugins-e2e sandbox roster must list shutdown so tools/list coverage tracks it',
  );
});
