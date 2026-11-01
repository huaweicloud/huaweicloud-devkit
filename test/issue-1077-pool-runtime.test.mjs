import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyQuotaError, resolvePoolTemplate } from '../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs';

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
