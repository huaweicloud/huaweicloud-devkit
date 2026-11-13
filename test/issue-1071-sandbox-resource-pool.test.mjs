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

// Acceptance 1: SKILL.md 两池 routing covers both pool types + selection rules
// （v3 口径：pool_type 选池，意图表 + 1+1 配额 + 同池复用）
test('issue-1071: resource pool routing table covers both sandbox types and selection rules', () => {
  assert.match(skill, /两池沙箱（pool_type）|两池沙箱/);
  assert.match(skill, /ephemeral/);
  assert.match(skill, /persistent/);
  assert.match(skill, /pool_type/);
  // 口径基调声明（#1076 修正 #7：两文档章节头均需注明"以实测为准"）
  assert.match(skill, /以实测为准/);
  // scenario rows（意图选池表）
  for (const kw of ['预览', '一次性任务', '敏感内容', '开发工作台', '带数据库项目', '跨日']) {
    assert.match(skill, new RegExp(kw));
  }
  // selection rules: agent auto-select + user override + per-type quota (1+1, same-type reuse)
  assert.match(skill, /按意图自动选池/);
  assert.match(skill, /开发者可覆盖/);
  assert.match(skill, /1\+1 可并存/);
  assert.match(skill, /同池 connect 自动复用/);
  // burning-core announcement wording (gifting + activity-earned)
  assert.match(skill, /赠送/);
  assert.match(skill, /活动赚取/);
});

// Acceptance 2: lifecycle semantics（v3 口径：ephemeral 闲置 30min 关机 + 1h 删除；
// persistent 闲置回收上限 7 天；单信号现状；无删除前通知）
test('issue-1071: lifecycle semantics (30min/1h ephemeral, 7-day persistent cap, single signal)', () => {
  assert.match(skill, /闲置 30 分钟自动关机/);
  assert.match(skill, /闲置 1 小时自动删除/);
  assert.match(skill, /上限 7 天/);
  // deletion discipline: no devkit-side lifecycle deletion API, second confirmation, no deferred delete
  assert.match(skill, /删除纪律/);
  assert.match(skill, /二次确认/);
  assert.match(skill, /不做延后代删|绝不做延后代删/);
  // activity signal status + G list live in the reference doc
  assert.match(resourcePool, /仅 connect 单信号|单信号/);
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    assert.match(resourcePool, new RegExp(`${g} `));
  }
});

// Acceptance 2b: final-report lifetime wording（ephemeral 不播报；persistent 只播报沙箱部分；
// 异常兜底提示保留）
test('issue-1071: final-report lifetime wording', () => {
  assert.doesNotMatch(skill, /必须转述/);
  assert.doesNotMatch(skill, /链接有效期 72 小时/);
  assert.match(skill, /ephemeral.*只给 URL/s);
  assert.match(skill, /不要.*迁移到持久沙箱或 OBS/s);
  assert.match(skill, /persistent.*只播报沙箱生命周期/s);
  assert.match(skill, /隧道将在会话结束后失效，请勿分享/);
  assert.match(skill, /例外：隧道无法持久/);

  assert.doesNotMatch(resourcePool, /TTL 播报为补偿方案/);
  assert.doesNotMatch(resourcePool, /生命周期数值是\*\*播报口径\*\*/);
  assert.doesNotMatch(resourcePool, /生命周期提示只在两个时机播报/);
  assert.doesNotMatch(resourcePool, /仍可播报/);
  assert.match(resourcePool, /ephemeral 不播报/);
  assert.match(resourcePool, /persistent 只播报沙箱生命周期/);

  const exposeDesc = tools.slice(tools.indexOf("'huaweicloud_sandbox_expose_tunnel'"));
  const exposeDescBlock = exposeDesc.slice(0, exposeDesc.indexOf('inputSchema'));
  assert.doesNotMatch(exposeDescBlock, /MUST be relayed/);
  assert.match(exposeDescBlock, /internal diagnostics/);
});

// Acceptance 2c: persistent 核时提示与主动关机纪律
test('issue-1071: persistent core-hours hint and shutdown discipline', () => {
  assert.match(skill, /关机纪律/);
  assert.match(skill, /huaweicloud_sandbox_shutdown/);
  assert.match(skill, /尽快关机/);
  assert.match(skill, /避免持续消耗核时/);
  assert.match(skill, /非持久化沙箱也可关机，但不主动提示/);
  assert.match(resourcePool, /sandbox_shutdown/);
  assert.match(resourcePool, /尽快关机/);
  assert.match(resourcePool, /避免持续消耗核时/);
});

// Acceptance 3: 429 + Retry-After dual error codes in tool descriptions
test('issue-1071: 429 + Retry-After quota semantics present in tool descriptions', () => {
  const connectDesc = tools.slice(tools.indexOf("'huaweicloud_sandbox_connect'"));
  const connectDescBlock = connectDesc.slice(0, connectDesc.indexOf('inputSchema'));
  assert.match(connectDescBlock, /429/);
  assert.match(connectDescBlock, /Retry-After/);
  assert.match(connectDescBlock, /HDKIT_QUOTA_EXCEEDED/);
  assert.match(connectDescBlock, /HDKIT_TEMPLATE_QUOTA_EXCEEDED/);
  assert.match(connectDescBlock, /HDKIT_CAPACITY_INSUFFICIENT/);
  assert.doesNotMatch(connectDescBlock, /dual error code/);
  assert.match(skill, /HDKIT_TEMPLATE_QUOTA_EXCEEDED/);
  assert.match(resourcePool, /HDKIT_TEMPLATE_QUOTA_EXCEEDED/);
  assert.match(connectDescBlock, /1 instance per pool type/);
  assert.match(connectDescBlock, /pool_type/);
  assert.match(connectDescBlock, /Lifecycle numbers are internal/);
  assert.match(connectDescBlock, /never surface ephemeral tunnel\/sandbox lifetime/);
  // close_session clarifies it does not delete the sandbox（v3：7 天口径）
  const closeDesc = tools.slice(tools.indexOf("'huaweicloud_sandbox_close_session'"));
  const closeDescBlock = closeDesc.slice(0, closeDesc.indexOf('inputSchema'));
  assert.match(closeDescBlock, /does NOT delete the sandbox instance/);
  assert.match(closeDescBlock, /second confirmation/);
  assert.match(closeDescBlock, /7-day/);
});

// Reference doc: resource/rate parameters
test('issue-1071: resource-pool reference documents pool capacity parameters', () => {
  assert.match(resourcePool, /300 实例/); // persistent 2U4G x300（原始申请口径）
  assert.match(resourcePool, /200 实例/); // persistent 4U8G x200（原始申请口径）
  assert.match(resourcePool, /1000 实例/); // ephemeral 2U4G x1000（原始申请口径）
  assert.match(resourcePool, /5 GB \/ 实例/); // overlayer per instance
  assert.match(resourcePool, /300 TB/); // EVS total
  assert.match(resourcePool, /EVS 32G|32G/); // persistent EVS mount
  assert.match(resourcePool, /3U6G/); // 实配 flavor（尾号 54）
  assert.match(resourcePool, /429/);
  assert.match(resourcePool, /Retry-After/);
  assert.match(resourcePool, /hcdke/); // 池前缀归属
  assert.match(resourcePool, /hcdkp/);
});
