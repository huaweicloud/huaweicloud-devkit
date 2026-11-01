import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

const skill = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
const tools = readFileSync(join(pluginRoot, 'src', 'tools.mjs'), 'utf8');
const resourcePool = readFileSync(
  join(pluginRoot, 'skills', 'huawei-sandbox', 'references', 'resource-pool.md'),
  'utf8',
);

// Acceptance 1: SKILL.md routing table covers both sandbox types + selection rules
test('issue-1071: resource pool routing table covers both sandbox types and selection rules', () => {
  assert.match(skill, /Resource Pool Selection/);
  assert.match(skill, /非持久化/);
  assert.match(skill, /持久化/);
  // scenario rows
  for (const kw of ['预览', '一次性任务', '敏感内容', '开发工作台', '带数据库项目', '跨日']) {
    assert.match(skill, new RegExp(kw));
  }
  // selection rules: agent auto-select + user override + per-type reuse
  assert.match(skill, /auto-select/i);
  assert.match(skill, /override/i);
  assert.match(skill, /1 instance per type/i);
  assert.match(skill, /non-persistent AND .* persistent|非持久化 AND 1 持久化|may hold 1 ephemeral AND 1 persistent/i);
  // burning-core announcement wording (gifting + activity-earned)
  assert.match(skill, /赠送/);
  assert.match(skill, /活动赚取/);
});

// Acceptance 2 (v2): lifecycle semantics — 7-day cap / connect-only signal / idle-configurable ephemeral
test('issue-1076: lifecycle v2 (1h idle / connect-only signal / 30min+1h ephemeral idle / 7-day retention / template_id pools)', () => {
  assert.match(skill, /Sandbox Lifecycle & Retention/);
  assert.match(skill, /1h idle/i);
  // v2: connect-only activity detection (three-signal caliber superseded)
  assert.match(skill, /当前仅 connect/i);
  assert.doesNotMatch(skill, /Three signals/i);
  // v2: ephemeral idle semantics (configurable, pending verification)
  assert.match(skill, /30min idle → shutdown（待验证）/);
  assert.match(skill, /1h idle → 自动删除（待验证）/);
  assert.match(skill, /闲置语义（待验证）/);
  // v2: 7-day hard cap (14-day caliber superseded)
  assert.match(skill, /最大 7 天/i);
  assert.doesNotMatch(skill, /14 days/i);
  // v2: template_id pool selection, no persist_mode request param
  assert.match(skill, /两池选择机制 = template_id/i);
  assert.match(skill, /没有 persist_mode/i);
  // v2: pre-shutdown notification NOT supported (G6 demand)
  assert.match(skill, /当前不支持删除\/关机前通知/i);
  // unchanged: no devkit-side deletion, second confirmation
  assert.match(skill, /second confirmation/i);
  assert.match(skill, /不做延后代删|never defers\/delays deletion/);
  // G1-G5 dependency markers
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(skill, new RegExp(`\\*\\*${g}\\*\\*`));
  }
});

// Acceptance 3: 429 + Retry-After semantics in tool descriptions
test('issue-1071: 429 + Retry-After quota semantics present in tool descriptions', () => {
  const connectDesc = tools.slice(tools.indexOf("'huaweicloud_sandbox_connect'"));
  const connectDescBlock = connectDesc.slice(0, connectDesc.indexOf('inputSchema'));
  assert.match(connectDescBlock, /429/);
  assert.match(connectDescBlock, /Retry-After/);
  assert.match(connectDescBlock, /quota-exceeded/i);
  assert.match(connectDescBlock, /capacity-insufficient/i);
  assert.match(connectDescBlock, /1 instance per type/i);
  // close_session clarifies it does not delete the sandbox
  const closeDesc = tools.slice(tools.indexOf("'huaweicloud_sandbox_close_session'"));
  const closeDescBlock = closeDesc.slice(0, closeDesc.indexOf('inputSchema'));
  assert.match(closeDescBlock, /does NOT delete the sandbox instance/);
  assert.match(closeDescBlock, /second confirmation/);
});

// Reference doc: resource/rate parameters
test('issue-1071: resource-pool reference documents pool capacity parameters', () => {
  assert.match(resourcePool, /300 实例/); // persistent 2U4G x300
  assert.match(resourcePool, /200 实例/); // persistent 4U8G x200
  assert.match(resourcePool, /1000 实例/); // ephemeral 2U4G x1000
  assert.match(resourcePool, /5 GB \/ 实例/); // overlayer per instance
  assert.match(resourcePool, /300 TB/); // EVS total
  assert.match(resourcePool, /EVS 32G|32G/); // persistent EVS mount
  assert.match(resourcePool, /429/);
  assert.match(resourcePool, /Retry-After/);
  // G list mirrored in reference
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(resourcePool, new RegExp(`${g} `));
  }
});
