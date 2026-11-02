import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot } from './structure-helpers.ts';

const skillPath = join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md');
const referencePath = join(
  pluginRoot,
  'src',
  'packs',
  'sandbox',
  'skills',
  'huawei-sandbox',
  'references',
  'resource-pool.md',
);
const toolsPath = join(pluginRoot, 'src', 'packs', 'sandbox', 'tools.ts');

function toolDescriptionBlock(tools: string, toolName: string): string {
  const fromTool = tools.slice(tools.indexOf(`'${toolName}'`));
  return fromTool.slice(0, fromTool.indexOf('schema'));
}

test('huawei-sandbox carries the resource-pool selection and lifecycle sections (#1071)', () => {
  const skill = readFileSync(skillPath, 'utf8');

  // Line-anchored heading lookups (same doctrine as the #1021 gate pins): a
  // ### demotion or a re-heading under an umbrella section cannot keep these
  // green, and the ordering pins keep the sections where an agent reading
  // top-down meets them before the Activation surface.
  const pool = /^## Resource Pool Selection \(持久化 vs 非持久化 — 定稿口径 #1071\)$/m.exec(skill);
  assert.ok(pool, 'Resource Pool Selection section missing as a top-level heading');
  const lifecycle = /^## Sandbox Lifecycle & Retention \(定稿口径 #1071\)$/m.exec(skill);
  assert.ok(lifecycle, 'Sandbox Lifecycle & Retention section missing as a top-level heading');
  const overview = /^## Overview/m.exec(skill)?.index ?? -1;
  const activation = /^## Activation/m.exec(skill)?.index ?? -1;
  assert.ok(overview !== -1 && overview < pool.index, 'pool section must follow the Overview intro');
  assert.ok(activation !== -1 && lifecycle.index < activation, 'lifecycle section must precede Activation');

  const poolSection = skill.slice(pool.index, lifecycle.index);
  for (const kw of ['预览', '一次性任务', '敏感内容', '开发工作台', '带数据库项目', '跨日']) {
    assert.match(poolSection, new RegExp(kw), `routing table must cover the ${kw} intent row`);
  }
  assert.match(poolSection, /auto-selects by intent/, 'the agent must auto-select by intent');
  assert.match(poolSection, /The developer can always override/, 'the developer override rule must hold');
  assert.match(poolSection, /1 instance per type/, 'per-type quota rule must be stated');
  assert.match(poolSection, /1 非持久化 AND 1 持久化/, 'holding both types simultaneously must be stated');
  assert.match(poolSection, /HTTP 429 with a Retry-After header/, 'the 429 + Retry-After contract must be stated');
  assert.match(poolSection, /quota exceeded/, 'quota-exceeded error class must be named');
  assert.match(poolSection, /capacity insufficient/, 'capacity-insufficient error class must be named');
  assert.match(poolSection, /赠送/, 'core-hour burn wording must carry the gifting term');
  assert.match(poolSection, /活动赚取/, 'core-hour burn wording must carry the activity-earned term');
  assert.match(poolSection, /EVS disk \(32G\)/, 'the persistent EVS mount must be stated');
  // The see-also link must not dead-end: the #999 heading it targets has to
  // exist at the level the anchor claims.
  assert.match(
    poolSection,
    /\[Sandbox filesystem persistence\]\(#sandbox-filesystem-persistence-what-survives-a-reboot-999\)/,
    'the EVS rule must link the filesystem-persistence section',
  );
  assert.match(
    skill,
    /^### Sandbox filesystem persistence: what survives a reboot \(#999\)$/m,
    'the filesystem-persistence heading the pool section links must exist',
  );

  const lifecycleSection = skill.slice(lifecycle.index, activation);
  assert.match(lifecycleSection, /1h idle → shutdown/, 'the 1h idle rule must be stated');
  assert.match(lifecycleSection, /relaxed from the platform's 10min/, 'the 10min relaxation note must be stated');
  assert.match(
    lifecycleSection,
    /terminal connect \/ running processes \/ preview traffic/,
    'the three activity signals must be named',
  );
  assert.match(lifecycleSection, /Fixed 3h from CreateTime/, 'the ephemeral hard expiry must be stated');
  assert.match(lifecycleSection, /14 days after stop/, 'the 14-day retention must be stated');
  assert.match(lifecycleSection, /second confirmation/, 'the deletion double-confirm must be stated');
  assert.match(lifecycleSection, /不做延后代删/, 'the no-deferred-deletion rule must be stated');
  assert.match(lifecycleSection, /No deletion API is exposed to devkit/, 'the no-deletion-API rule must be stated');
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(lifecycleSection, new RegExp(`\\*\\*${g}\\*\\*`), `platform dependency ${g} must be listed`);
  }
});

test('workflow sequences pool selection (Step 0.3) between the target gate and the stack gate (#1071)', () => {
  const skill = readFileSync(skillPath, 'utf8');

  // Position, not just presence: after the target gate resolves and before
  // the stack gate opens code transfer, the pool choice is checked against
  // the lifecycle window — both anchors must link the real headings.
  assert.match(
    skill,
    /\*\*Step 0\.3 — Resource pool selection\*\*: once the target is sandbox, pick the pool type per the \[Resource Pool Selection\]\(#resource-pool-selection-持久化-vs-非持久化--定稿口径-1071\) table/,
    'Step 0.3 must link the pool table at its real heading anchor',
  );
  assert.match(
    skill,
    /\[Sandbox Lifecycle & Retention\]\(#sandbox-lifecycle--retention-定稿口径-1071\)\) before connecting/,
    'Step 0.3 must link the lifecycle table at its real heading anchor',
  );
  const step0 = skill.indexOf('**Step 0 — Target-Selection Gate (MANDATORY)**');
  const step03 = skill.indexOf('**Step 0.3 — Resource pool selection**');
  const step05 = skill.indexOf('**Step 0.5 — Stack-Selection Gate (MANDATORY)**');
  assert.ok(step0 !== -1 && step03 !== -1 && step0 < step03, 'Step 0.3 must follow Step 0');
  assert.ok(step05 !== -1 && step03 < step05, 'Step 0.3 must precede Step 0.5');
});

test('resource-pool reference documents the pool capacity parameters and is linked (#1071)', () => {
  const resourcePool = readFileSync(referencePath, 'utf8');
  assert.match(resourcePool, /300 实例/, 'persistent 2U4G capacity must be documented');
  assert.match(resourcePool, /200 实例/, 'persistent 4U8G capacity must be documented');
  assert.match(resourcePool, /1000 实例/, 'ephemeral 2U4G capacity must be documented');
  assert.match(resourcePool, /5 GB \/ 实例/, 'overlayer per-instance quota must be documented');
  assert.match(resourcePool, /300 TB/, 'EVS total capacity must be documented');
  assert.match(resourcePool, /32G/, 'the persistent EVS mount size must be documented');
  assert.match(resourcePool, /429/, 'the 429 contract must be documented');
  assert.match(resourcePool, /Retry-After/, 'the Retry-After header must be documented');
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(resourcePool, new RegExp(`${g} `), `platform dependency ${g} must be mirrored`);
  }

  const skill = readFileSync(skillPath, 'utf8');
  assert.match(
    skill,
    /- \[Resource Pool\]\(references\/resource-pool\.md\) — 资源池定稿口径/,
    'the References list must link the resource-pool reference',
  );
  // The late-flow catch-all surface: the warnings table carries the pool row
  // beside the two gate rows (the #1021 v2-wins precedent — the table is the
  // surface an agent consults last).
  assert.match(skill, /Pool type fixes durability/, 'the Critical Warnings table must carry the pool-type row');
});

test('sandbox tool descriptions carry the quota/429 and no-delete semantics (#1071)', () => {
  const tools = readFileSync(toolsPath, 'utf8');

  const connectDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_connect');
  assert.match(connectDesc, /One user one instance per pool type/, 'connect must state per-pool-type reuse');
  assert.match(connectDesc, /1 instance per type/, 'connect must state the per-type quota');
  assert.match(connectDesc, /1 ephemeral AND 1 persistent/, 'connect must state dual-type holding');
  assert.match(connectDesc, /HTTP 429 with a Retry-After header/, 'connect must state the 429 contract');
  assert.match(connectDesc, /quota-exceeded/, 'connect must name the quota-exceeded class');
  assert.match(connectDesc, /capacity-insufficient/, 'connect must name the capacity-insufficient class');
  assert.match(connectDesc, /fixed 3h from CreateTime/, 'connect must state the ephemeral expiry');
  assert.match(connectDesc, /EVS 32G mounted/, 'connect must state the persistent EVS mount');
  assert.match(connectDesc, /1h idle shutdown/, 'connect must state the idle shutdown rule');
  assert.match(connectDesc, /14-day retention/, 'connect must state the retention window');
  // v2 divergence: the vendor-gate seam stays on the connect description.
  assert.match(connectDesc, /Vendor-gated \(vendorConfirmed\)/, 'connect must keep the vendor-gate sentence');

  const closeDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_close_session');
  assert.match(closeDesc, /does NOT delete the sandbox instance/, 'close_session must disclaim deletion');
  assert.match(closeDesc, /second confirmation/, 'close_session must demand the deletion double-confirm');
  assert.match(closeDesc, /14-day retention/, 'close_session must state the retention window');
  assert.match(closeDesc, /idle-deletion policy/, 'close_session must name the platform reclaim path');
});
