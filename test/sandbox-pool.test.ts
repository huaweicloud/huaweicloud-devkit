import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  validatePoolType,
  pinnedTemplateFor,
  rememberWorkspacePool,
  forgetWorkspacePool,
  poolContextFor,
  enrichConnectResult,
  withPoolContext,
} = await import('../plugins/huaweicloud-core/src/lib/hdkit/sandbox-pool.ts');

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

const POOL_TEMPLATE_ENV_KEYS = ['HW_POOL_TEMPLATE_EPHEMERAL', 'HW_POOL_TEMPLATE_PERSISTENT'] as const;

function withPinnedTemplateEnv(env: Partial<Record<(typeof POOL_TEMPLATE_ENV_KEYS)[number], string>>, fn: () => void) {
  const saved: Partial<Record<(typeof POOL_TEMPLATE_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of POOL_TEMPLATE_ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of POOL_TEMPLATE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

test('pinnedTemplateFor reads env and is empty by default', () => {
  withPinnedTemplateEnv({}, () => {
    assert.equal(pinnedTemplateFor('ephemeral'), '');
    assert.equal(pinnedTemplateFor(null), '');
  });
  withPinnedTemplateEnv({ HW_POOL_TEMPLATE_EPHEMERAL: 'tpl-e', HW_POOL_TEMPLATE_PERSISTENT: 'tpl-p' }, () => {
    assert.equal(pinnedTemplateFor('ephemeral'), 'tpl-e');
    assert.equal(pinnedTemplateFor('persistent'), 'tpl-p');
  });
});

// ── workspace 池缓存与上下文（模式提示）──

test('poolContextFor returns mode hint per pool and undefined when unknown', () => {
  forgetWorkspacePool();
  assert.equal(poolContextFor('ws1'), undefined);

  rememberWorkspacePool('ws1', 'ephemeral');
  const eph = poolContextFor('ws1');
  assert.equal(eph?.poolMode, 'ephemeral');
  assert.match(eph?.persistenceHint ?? '', /30 分钟自动关机/);

  rememberWorkspacePool('ws2', 'persistent');
  const per = poolContextFor('ws2');
  assert.equal(per?.poolMode, 'persistent');
  assert.match(per?.persistenceHint ?? '', /7 天/);

  forgetWorkspacePool('ws1');
  assert.equal(poolContextFor('ws1'), undefined);
  assert.ok(poolContextFor('ws2'), 'exact cleanup must not affect other workspaces');
  forgetWorkspacePool();
});

// ── enrichConnectResult（TTL 播报，仅服务端回显 pool_type 时）──

test('enrichConnectResult broadcasts ephemeral lifecycle only on server echo', () => {
  const result = enrichConnectResult({ session_id: 's1', pool_type: 'ephemeral' }) as {
    pool?: { pool_type: string; ttl_hint: string };
  };
  assert.ok(result.pool);
  assert.equal(result.pool.pool_type, 'ephemeral');
  assert.match(result.pool.ttl_hint, /30 分钟/);
  assert.match(result.pool.ttl_hint, /1 小时/);
  assert.match(result.pool.ttl_hint, /persistent/); // 指引换池
});

test('enrichConnectResult broadcasts persistent lifecycle on server echo', () => {
  const result = enrichConnectResult({ session_id: 's1', pool_type: 'persistent' }) as {
    pool?: { pool_type: string; ttl_hint: string };
  };
  assert.equal(result.pool?.pool_type, 'persistent');
  assert.match(result.pool?.ttl_hint ?? '', /7 天/);
});

test('enrichConnectResult falls back to camelCase poolType echo (wire naming drift guard)', () => {
  const ephemeral = enrichConnectResult({ session_id: 's1', poolType: 'ephemeral' }) as {
    pool?: { pool_type: string; ttl_hint: string };
  };
  assert.ok(ephemeral.pool, 'camelCase echo must still broadcast lifecycle');
  assert.equal(ephemeral.pool.pool_type, 'ephemeral');
  assert.match(ephemeral.pool.ttl_hint, /30 分钟/);

  const persistent = enrichConnectResult({ session_id: 's1', poolType: 'persistent' }) as {
    pool?: { pool_type: string };
  };
  assert.equal(persistent.pool?.pool_type, 'persistent');
});

test('enrichConnectResult adds nothing without server pool echo (custom template / old server)', () => {
  const result = enrichConnectResult({ session_id: 's1', template_id: 'custom' }) as { pool?: unknown };
  assert.equal(result.pool, undefined);

  const oldServer = enrichConnectResult({ session_id: 's1' }) as { pool?: unknown };
  assert.equal(oldServer.pool, undefined);
});

// ── withPoolContext ──

test('withPoolContext merges hint into object results and passes others through', () => {
  forgetWorkspacePool();
  rememberWorkspacePool('ws1', 'ephemeral');
  const merged = withPoolContext('ws1', { stdout: 'ok', exitCode: 0 }) as {
    stdout: string;
    poolMode?: string;
    persistenceHint?: string;
  };
  assert.equal(merged.stdout, 'ok');
  assert.equal(merged.poolMode, 'ephemeral');
  assert.match(merged.persistenceHint ?? '', /非持久沙箱/);

  // 未记录池归属：原对象不加字段（浅拷贝保持原引用语义安全）
  const untouched = withPoolContext('ws-unknown', { a: 1 }) as { a?: number; poolMode?: string };
  assert.equal(untouched.a, 1);
  assert.equal(untouched.poolMode, undefined);

  // 非对象结果原样返回
  assert.equal(withPoolContext('ws1', 'ok'), 'ok');
  forgetWorkspacePool();
});
