import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

process.env.HW_SANDBOX_POOL_CACHE_PATH = join(tmpdir(), `hw-sandbox-pool-test-${process.pid}.json`);

const {
  validatePoolType,
  pinnedTemplateFor,
  rememberWorkspacePool,
  forgetWorkspacePool,
  poolContextFor,
  enrichConnectResult,
  shouldAnnounceConnect,
  buildExposeLifetimeNotice,
} = await import('../plugins/huaweicloud-core/src/sandbox/sandbox-pool.mjs');

// ── validatePoolType ──

test('validatePoolType returns null when absent (server defaults to ephemeral)', () => {
  assert.equal(validatePoolType(undefined), null);
  assert.equal(validatePoolType(null), null);
  assert.equal(validatePoolType(''), null);
});

test('validatePoolType normalizes case and whitespace', () => {
  assert.equal(validatePoolType('ephemeral'), 'ephemeral');
  assert.equal(validatePoolType('EPHEMERAL'), 'ephemeral');
  assert.equal(validatePoolType(' Persistent '), 'persistent');
});

test('validatePoolType rejects invalid values with guidance', () => {
  assert.throws(() => validatePoolType('weird'), /invalid pool_type/);
  assert.throws(() => validatePoolType('persist_mode'), /invalid pool_type/);
});

// ── pinnedTemplateFor（运维钉扎，环境变量）──

test('pinnedTemplateFor reads env and is empty by default', () => {
  delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
  assert.equal(pinnedTemplateFor('ephemeral'), '');
  process.env.HW_POOL_TEMPLATE_EPHEMERAL = 'tpl-e';
  process.env.HW_POOL_TEMPLATE_PERSISTENT = 'tpl-p';
  assert.equal(pinnedTemplateFor('ephemeral'), 'tpl-e');
  assert.equal(pinnedTemplateFor('persistent'), 'tpl-p');
  assert.equal(pinnedTemplateFor(null), '');
  delete process.env.HW_POOL_TEMPLATE_EPHEMERAL;
  delete process.env.HW_POOL_TEMPLATE_PERSISTENT;
});

// ── workspace 池缓存与上下文 ──

test('poolContextFor uses server-configured lifecycle and defaults when absent', () => {
  forgetWorkspacePool();
  assert.equal(poolContextFor('ws1'), undefined);

  rememberWorkspacePool('ws1', 'ephemeral');
  const eph = poolContextFor('ws1');
  assert.equal(eph.poolMode, 'ephemeral');
  assert.equal(eph.poolLifecycle.idleShutdownMinutes, 30);
  assert.equal(eph.poolLifecycle.idleDeleteMinutes, 60);
  assert.match(eph.persistenceHint, /30 分钟自动关机/);
  assert.match(eph.persistenceHint, /1 小时自动删除/);

  rememberWorkspacePool('ws2', 'persistent');
  const per = poolContextFor('ws2');
  assert.equal(per.poolMode, 'persistent');
  assert.equal(per.poolLifecycle.idleShutdownMinutes, 60);
  assert.equal(per.poolLifecycle.reclaimDays, 7);
  assert.match(per.persistenceHint, /1 小时自动关机/);
  assert.match(per.persistenceHint, /7 天/);

  // 服务端配置值优先于默认
  rememberWorkspacePool('ws3', 'ephemeral', {
    pool_idle_shutdown_minutes: 45,
    pool_idle_delete_minutes: 120,
  });
  const custom = poolContextFor('ws3');
  assert.equal(custom.poolLifecycle.idleShutdownMinutes, 45);
  assert.equal(custom.poolLifecycle.idleDeleteMinutes, 120);
  assert.match(custom.persistenceHint, /45 分钟自动关机/);
  assert.match(custom.persistenceHint, /2 小时自动删除/);

  forgetWorkspacePool('ws1');
  assert.equal(poolContextFor('ws1'), undefined);
  assert.ok(poolContextFor('ws2')); // 精确清理不影响其他 workspace
  forgetWorkspacePool();
});

test('workspace pool cache persists to disk and reloads in a fresh module instance', async () => {
  forgetWorkspacePool();
  rememberWorkspacePool('ws-cache', 'persistent', { pool_reclaim_days: 9 });

  const persisted = JSON.parse(readFileSync(process.env.HW_SANDBOX_POOL_CACHE_PATH, 'utf8'));
  assert.equal(persisted.workspaces['ws-cache'].poolType, 'persistent');
  assert.equal(persisted.workspaces['ws-cache'].lifecycle.reclaimDays, 9);

  // 模拟 MCP 进程重启：新模块实例从磁盘缓存恢复（进程内 announcement 状态不落盘）
  const fresh = await import(
    `../plugins/huaweicloud-core/src/sandbox/sandbox-pool.mjs?restart=${Date.now()}`
  );
  const ctx = fresh.poolContextFor('ws-cache');
  assert.equal(ctx.poolMode, 'persistent');
  assert.equal(ctx.poolLifecycle.reclaimDays, 9);
  forgetWorkspacePool();
});

// ── connect 播报时机 ──

test('shouldAnnounceConnect announces first connect, suppresses reuse, re-announces on wake-up', () => {
  forgetWorkspacePool();
  assert.equal(shouldAnnounceConnect('ws-a', { started: false }), true);
  assert.equal(shouldAnnounceConnect('ws-a', { started: false }), false);
  assert.equal(shouldAnnounceConnect('ws-a', { started: true }), true);

  assert.equal(shouldAnnounceConnect('ws-b', { startedFromStopped: true }), true);
  forgetWorkspacePool();
});

// ── enrichConnectResult（TTL 播报）──

test('enrichConnectResult broadcasts server-configured ephemeral lifecycle', () => {
  const result = enrichConnectResult({
    session_id: 's1',
    pool_type: 'ephemeral',
    pool_idle_shutdown_minutes: 45,
    pool_idle_delete_minutes: 120,
  });
  assert.ok(result.pool);
  assert.equal(result.pool.pool_type, 'ephemeral');
  assert.match(result.pool.ttl_hint, /45 分钟自动关机/);
  assert.match(result.pool.ttl_hint, /2 小时自动删除/);
  assert.match(result.pool.lifecycle, /45min/);
});

test('enrichConnectResult falls back to client defaults when lifecycle fields are missing', () => {
  const result = enrichConnectResult({ session_id: 's1', pool_type: 'ephemeral' });
  assert.match(result.pool.ttl_hint, /30 分钟自动关机/);
  assert.match(result.pool.ttl_hint, /1 小时自动删除/);
});

test('enrichConnectResult broadcasts persistent lifecycle on server echo', () => {
  const result = enrichConnectResult({ session_id: 's1', pool_type: 'persistent' });
  assert.equal(result.pool.pool_type, 'persistent');
  assert.match(result.pool.ttl_hint, /闲置 1 小时自动关机/);
  assert.match(result.pool.ttl_hint, /7 天/);
});

test('enrichConnectResult supports camelCase lifecycle echo (wire naming drift guard)', () => {
  const result = enrichConnectResult({
    session_id: 's1',
    poolType: 'persistent',
    poolIdleShutdownMinutes: 90,
    poolReclaimDays: 5,
  });
  assert.ok(result.pool, 'camelCase echo must still broadcast lifecycle');
  assert.match(result.pool.ttl_hint, /1 小时 30 分钟|90 分钟/);
  assert.match(result.pool.ttl_hint, /5 天/);
});

test('enrichConnectResult suppresses the hint when announce=false (reuse)', () => {
  const result = enrichConnectResult(
    { session_id: 's1', pool_type: 'ephemeral' },
    { announce: false },
  );
  assert.equal(result.pool, undefined);
});

test('enrichConnectResult adds nothing without server pool echo (custom template / old server)', () => {
  const custom = enrichConnectResult({ session_id: 's1', template_id: 'custom' });
  assert.equal(custom.pool, undefined);

  const oldServer = enrichConnectResult({ session_id: 's1' });
  assert.equal(oldServer.pool, undefined);
});

// ── 交付地址存活期提示 ──

test('buildExposeLifetimeNotice renders ephemeral URL lifetime with tunnel expiry', () => {
  const notice = buildExposeLifetimeNotice(
    {
      poolMode: 'ephemeral',
      poolLifecycle: {
        poolType: 'ephemeral',
        idleShutdownMinutes: 30,
        idleDeleteMinutes: 60,
        reclaimDays: null,
      },
    },
    72,
  );
  assert.equal(notice.sandboxLifetime.poolType, 'ephemeral');
  assert.equal(notice.sandboxLifetime.idleShutdownMinutes, 30);
  assert.equal(notice.sandboxLifetime.idleDeleteMinutes, 60);
  assert.match(notice.urlLifetimeHint, /闲置 30 分钟自动关机/);
  assert.match(notice.urlLifetimeHint, /闲置 1 小时自动删除/);
  assert.match(notice.urlLifetimeHint, /隧道有效期 72 小时/);
  assert.match(notice.warning, /URL 存活期提示/);
});

test('buildExposeLifetimeNotice renders persistent URL lifetime (data retained on shutdown)', () => {
  const notice = buildExposeLifetimeNotice(
    {
      poolMode: 'persistent',
      poolLifecycle: {
        poolType: 'persistent',
        idleShutdownMinutes: 60,
        idleDeleteMinutes: null,
        reclaimDays: 7,
      },
    },
    720,
  );
  assert.equal(notice.sandboxLifetime.poolType, 'persistent');
  assert.equal(notice.sandboxLifetime.reclaimDays, 7);
  assert.match(notice.urlLifetimeHint, /闲置 1 小时自动关机/);
  assert.match(notice.urlLifetimeHint, /实例与数据盘保留/);
  assert.match(notice.urlLifetimeHint, /隧道有效期 720 小时/);
});

test('buildExposeLifetimeNotice returns undefined when pool semantics are unknown', () => {
  assert.equal(buildExposeLifetimeNotice(undefined, 72), undefined);
  assert.equal(buildExposeLifetimeNotice({}, 72), undefined);
});