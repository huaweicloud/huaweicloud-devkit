import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { classifyQuotaError } from '../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs';
import {
  resolvePoolTemplate,
  getPoolLifecycleGuidance,
  buildConnectPoolInfo,
} from '../plugins/huaweicloud-core/src/sandbox/sandbox-pool-config.mjs';

const EPH = 'tpl-ephemeral-001';
const PER = 'tpl-persistent-001';

test('issue-1077: classifyQuotaError — 429 quota exceeded with Retry-After', () => {
  const r = classifyQuotaError(429, 'HDKIT_QUOTA_EXCEEDED', '120');
  assert.equal(r.kind, 'quota_exceeded');
  assert.equal(r.retryAfter, '120');
  assert.ok(r.remediation.hint.includes('每用户每类型 1 个实例'));
  assert.ok(r.remediation.steps.some((s) => s.includes('Retry-After=120')));
});

test('issue-1077: classifyQuotaError — 429 capacity insufficient', () => {
  const r = classifyQuotaError(429, 'HDKIT_CAPACITY_INSUFFICIENT', '');
  assert.equal(r.kind, 'capacity_insufficient');
  assert.equal(r.retryAfter, '');
  assert.ok(r.remediation.hint.includes('池侧无可用容量'));
});

test('issue-1077: classifyQuotaError — non-429 or unknown code returns null', () => {
  assert.equal(classifyQuotaError(500, 'HDKIT_QUOTA_EXCEEDED', '10'), null);
  assert.equal(classifyQuotaError(429, 'SOME_OTHER_CODE', '10'), null);
  assert.equal(classifyQuotaError(200, 'HDKIT_QUOTA_EXCEEDED', ''), null);
});

test('issue-1077: resolvePoolTemplate — explicit template_id always wins', () => {
  process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL = EPH;
  const r = resolvePoolTemplate('persistent', 'tpl-explicit');
  assert.equal(r.template_id, 'tpl-explicit');
  assert.equal(r.source, 'explicit');
});

test('issue-1077: resolvePoolTemplate — pool_type maps via env config', () => {
  process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL = EPH;
  process.env.HDKIT_POOL_TEMPLATE_PERSISTENT = PER;
  assert.deepEqual(resolvePoolTemplate('ephemeral', undefined), { template_id: EPH, source: 'pool_map' });
  assert.deepEqual(resolvePoolTemplate('persistent', undefined), { template_id: PER, source: 'pool_map' });
});

test('issue-1077: resolvePoolTemplate — unmapped pool_type throws a config hint', () => {
  delete process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL;
  delete process.env.HDKIT_POOL_TEMPLATE_PERSISTENT;
  assert.throws(() => resolvePoolTemplate('ephemeral', undefined), /HDKIT_POOL_TEMPLATE_EPHEMERAL/);
  assert.throws(() => resolvePoolTemplate('persistent', undefined), /HDKIT_POOL_TEMPLATE_PERSISTENT/);
});

test('issue-1077: resolvePoolTemplate — invalid pool_type rejected', () => {
  assert.throws(() => resolvePoolTemplate('gaming', undefined), /Invalid pool_type/);
});

test('issue-1077: resolvePoolTemplate — no pool_type and no template = server default', () => {
  delete process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL;
  assert.deepEqual(resolvePoolTemplate(undefined, undefined), { template_id: '', source: 'default' });
});

test('issue-1077: tools.mjs connect schema exposes pool_type enum', async () => {
  const { readFileSync } = await import('node:fs');
  const tools = readFileSync(new URL('../plugins/huaweicloud-core/src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /pool_type:/);
  assert.match(tools, /'ephemeral', 'persistent'/);
  assert.match(tools, /HDKIT_POOL_TEMPLATE_EPHEMERAL/);
});

// ============ 池配置文件层 ============

const POOL_CFG = { templates: { ephemeral: 'tpl-eph-from-file', persistent: 'tpl-per-from-file' } };

function withPoolConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'poolcfg-'));
  const cfgPath = join(dir, 'sandbox-pools.json');
  writeFileSync(cfgPath, JSON.stringify(POOL_CFG));
  process.env.HDKIT_SANDBOX_POOLS_CONFIG = cfgPath;
  try {
    fn();
  } finally {
    delete process.env.HDKIT_SANDBOX_POOLS_CONFIG;
  }
}

test('issue-1077: resolvePoolTemplate — config file mapping', () => {
  withPoolConfig(() => {
    assert.deepEqual(resolvePoolTemplate('ephemeral', undefined), {
      template_id: 'tpl-eph-from-file',
      source: 'pool_map',
    });
    assert.deepEqual(resolvePoolTemplate('persistent', undefined), {
      template_id: 'tpl-per-from-file',
      source: 'pool_map',
    });
  });
});

test('issue-1077: config file takes precedence over env', () => {
  withPoolConfig(() => {
    process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL = 'tpl-from-env';
    assert.equal(resolvePoolTemplate('ephemeral', undefined).template_id, 'tpl-eph-from-file');
    delete process.env.HDKIT_POOL_TEMPLATE_EPHEMERAL;
  });
});

test('issue-1077: getPoolLifecycleGuidance — ephemeral carries idle semantics with 待验证 marker', () => {
  const g = getPoolLifecycleGuidance('ephemeral');
  assert.match(g.lifecycle, /30min.*30 分钟闲置自动关机|30min 闲置关机/);
  assert.match(g.lifecycle, /1h 闲置自动删除/);
  assert.match(g.verification, /待验证/);
  assert.match(g.durability, /不承诺/);
});

test('issue-1077: getPoolLifecycleGuidance — persistent carries 7-day cap + connect-only signal', () => {
  const g = getPoolLifecycleGuidance('persistent');
  assert.match(g.retention, /7 天/);
  assert.ok(!/最长保留 14 天/.test(g.retention)); // 作废声明（原 14 天口径已作废）允许存在
  assert.match(g.idle, /仅 connect/);
  assert.match(g.storage, /EVS 32G/);
});

test('issue-1077: getPoolLifecycleGuidance — unknown pool returns null', () => {
  assert.equal(getPoolLifecycleGuidance('gaming'), null);
});

test('issue-1077: buildConnectPoolInfo — full enrichment payload', () => {
  const info = buildConnectPoolInfo('persistent', 'tpl-x', 'pool_map');
  assert.equal(info.type, 'persistent');
  assert.equal(info.template_id, 'tpl-x');
  assert.equal(info.template_source, 'pool_map');
  assert.equal(info.lifecycle.retention.includes('7 天'), true);
  assert.match(info.quota, /429/);
});

test('issue-1077: connect handler surfaces structured quota error (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const tools = readFileSync(new URL('../plugins/huaweicloud-core/src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /error_kind: error\.kind/);
  assert.match(tools, /retry_after: error\.retryAfter/);
  assert.match(tools, /pool: poolInfo/);
  assert.match(tools, /resolvePoolTemplate\(args\.pool_type, args\.template_id\)/);
});
