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

test('huawei-sandbox carries the two-pool pool_type selection section (v3 caliber)', () => {
  const skill = readFileSync(skillPath, 'utf8');

  // Line-anchored heading lookups (same doctrine as the #1021 gate pins): a
  // ### demotion or a re-heading under an umbrella section cannot keep these
  // green, and the ordering pins keep the section where an agent reading
  // top-down meets it before the Activation surface.
  const pool = /^## 两池沙箱（pool_type）$/m.exec(skill);
  assert.ok(pool, '两池沙箱 section missing as a top-level heading');
  const overview = /^## Overview/m.exec(skill)?.index ?? -1;
  const activation = /^## Activation/m.exec(skill)?.index ?? -1;
  assert.ok(overview !== -1 && overview < pool.index, 'pool section must follow the Overview intro');
  assert.ok(activation !== -1 && pool.index < activation, 'pool section must precede Activation');

  const poolSection = skill.slice(pool.index, activation);
  // 口径基调 blockquote（dev 805f24ba）：实测基调声明必须以块引用形态先于
  // 本节一切表格（口头支持不作数——平台调参后随实测更新）。
  const caliber =
    /^> 口径基调：一切以实测为准，口头支持不作数（下表生命周期为实测\/平台侧现状，平台调参后本节随之更新）。$/m.exec(
      poolSection,
    );
  assert.ok(caliber, 'the section must open with the measured-caliber blockquote');
  const mechanism = poolSection.indexOf('用 `pool_type` 选择资源池');
  assert.ok(mechanism !== -1 && caliber.index < mechanism, 'the caliber blockquote must precede the mechanism lead');
  // Mapping-bearing pins (the #1021 doctrine: pin the routing semantics with
  // regexes that carry the mapping, not keyword presence — a pool-type flip
  // in any row must red the gate).
  assert.match(
    poolSection,
    /用 `pool_type` 选择资源池（服务端权威映射模板；\*\*没有 persist_mode 参数\*\*/,
    'the section must open with the pool_type mechanism and the no-persist_mode fact',
  );
  assert.match(
    poolSection,
    /\| `ephemeral`（默认）\s+\| 非持久沙箱\s+\| 闲置 30 分钟自动关机 \+ 闲置 1 小时自动删除（平台定时任务）\s+\| 临时运行\/预览，勿存重要数据\s*\|/,
    'the type table must keep the ephemeral row with its measured 30min/1h lifecycle',
  );
  assert.match(
    poolSection,
    /\| `persistent`\s+\| 持久沙箱（EVS 盘）\s+\| 数据跨关机保留；闲置回收保留期上限 7 天\s+\| 需要跨会话保留数据\s*\|/,
    'the type table must keep the persistent row with the 7-day reclaim cap',
  );
  // Selection-rules table rows: intent → pool_type mapping with the reason.
  for (const [intent, poolType] of [
    ['预览 / 试用 / demo', 'ephemeral'],
    ['一次性任务（跑完即弃）', 'ephemeral'],
    ['敏感内容（即焚）', 'ephemeral'],
    ['开发工作台 / workbench', 'persistent'],
    ['带数据库项目（DB-backed）', 'persistent'],
    ['跨日评审 / 展示', 'persistent'],
  ] as const) {
    assert.match(
      poolSection,
      new RegExp(`\\|\\s*${intent}\\s+\\|\\s*${poolType}\\s+\\|`),
      `${intent} must route to ${poolType}`,
    );
  }
  // Shield-class absence pins (the round-4 countermeasure, applied to the
  // selection table): a flipped row plus a re-provided correct duplicate must
  // red — the wrong-mapping forms must not appear anywhere in the section.
  for (const [intent, wrongType] of [
    ['预览 / 试用 / demo', 'persistent'],
    ['一次性任务（跑完即弃）', 'persistent'],
    ['敏感内容（即焚）', 'persistent'],
    ['开发工作台 / workbench', 'ephemeral'],
    ['带数据库项目（DB-backed）', 'ephemeral'],
    ['跨日评审 / 展示', 'ephemeral'],
  ] as const) {
    assert.doesNotMatch(
      poolSection,
      new RegExp(`\\|\\s*${intent}\\s+\\|\\s*${wrongType}\\s+\\|`),
      `${intent} must never route to ${wrongType}`,
    );
  }
  // Selection-rule leads (auto-select + override + per-type quota/reuse).
  assert.match(
    poolSection,
    /agent 按意图自动选池，开发者可覆盖；意图不明确时呈现两类供选择/,
    'the selection rules must state auto-select with developer override',
  );
  assert.match(
    poolSection,
    /\*\*配额\*\*：每用户每类型 1 台（1\+1 可并存）；同池 connect 自动复用已有实例/,
    'the per-type quota bullet must state the 1+1 model with same-pool reuse',
  );
  // The 429 dual-code doctrine: the two codes with their opposite remedies,
  // plus the Retry-After arrival — a code-to-remedy swap reds the gate.
  assert.match(
    poolSection,
    /\*\*429 双错误码\*\*：`HDKIT_QUOTA_EXCEEDED`（账号配额满，重试无效→引导释放\/复用）；`HDKIT_CAPACITY_INSUFFICIENT`（池容量不足→建议错峰重试）。响应带 `Retry-After`/,
    'the 429 dual-code bullet must map each code to its distinct remedy with the Retry-After arrival',
  );
  assert.doesNotMatch(
    poolSection,
    /HDKIT_QUOTA_EXCEEDED`（池容量不足/,
    'quota-exceeded must never carry the capacity remedy',
  );
  assert.doesNotMatch(
    poolSection,
    /HDKIT_CAPACITY_INSUFFICIENT`（账号配额满/,
    'capacity-insufficient must never carry the quota remedy',
  );
  // TTL broadcast duty (缺口#1/#2 teaching): the ephemeral URL-invalidity
  // warning is the load-bearing clause for URL handover.
  assert.match(
    poolSection,
    /\*\*TTL 播报\*\*：connect 与执行类工具返回值带池模式\/生命周期提示——\*\*ephemeral 池部署的公网地址会随沙箱闲置关机失效\*\*，向开发者交付 URL 时必须附带该提示/,
    'the TTL broadcast bullet must pin the ephemeral-URL-dies warning as a URL-handover duty',
  );
  // Burn-core caliber: gifting wording + the HD.97520422 exhaustion code.
  assert.match(
    poolSection,
    /\*\*烧核播报口径\*\*：沙箱运行消耗核时，播报用「平台赠送 \+ 活动赚取」口径（非直接计费）；账号核时耗尽（`HD\.97520422`）时工具返回值给出友好引导/,
    'the burn bullet must carry the gifting caliber and the HD.97520422 exhaustion code',
  );
  // Deletion discipline: no lifecycle deletion API, double confirm, never
  // deferred deletes.
  assert.match(
    poolSection,
    /\*\*删除纪律\*\*：不向开发者暴露生命周期删除 API（回收走平台闲置策略 G1）；开发者主动删除时必须二次确认（确认要删除？数据不可恢复）；绝不做延后代删/,
    'the deletion-discipline bullet must state the no-API rule, the double confirm, and no deferred deletes',
  );
  // Explicit template_id wins over pool_type (custom template scenario).
  assert.match(
    poolSection,
    /显式 `template_id` 优先于 `pool_type`（自定义模板场景）/,
    'explicit template_id must be documented as taking precedence',
  );
  assert.match(
    poolSection,
    /完整口径、容量规划与 G 清单：\[references\/resource-pool\.md\]\(references\/resource-pool\.md\)/,
    'the section must link the reference doc in context',
  );
  // The see-also surface the pinned EVS rule used to link stays real: the
  // #999 filesystem-persistence heading must still exist for the warnings
  // row that links it.
  assert.match(
    skill,
    /^### Sandbox filesystem persistence: what survives a reboot \(#999\)$/m,
    'the filesystem-persistence heading the warnings row links must exist',
  );
});

test('workflow sequences pool selection (Step 0.3) between the target gate and the stack gate (v3 caliber)', () => {
  const skill = readFileSync(skillPath, 'utf8');

  // Position, not just presence: after the target gate resolves and before
  // the stack gate opens code transfer, the pool choice is checked against
  // the lifecycle window — both the anchor and the v3 lifecycle gloss must
  // hold seam to seam.
  assert.match(
    skill,
    /\*\*Step 0\.3 — Resource pool selection\*\*: once the target is sandbox, pick the pool type per the \[两池沙箱（pool_type）\]\(#两池沙箱pool_type\) selection rules \(auto by intent, developer may override; 1 instance per type, same type reuses\)\. Check the task survives the chosen type's lifecycle window \(ephemeral: idle 30min shutdown \+ 1h delete; persistent: 7-day idle reclaim cap\) before connecting\./,
    'Step 0.3 must link the 两池 section at its real heading anchor with the v3 lifecycle window',
  );
  const step0 = skill.indexOf('**Step 0 — Target-Selection Gate (MANDATORY)**');
  const step03 = skill.indexOf('**Step 0.3 — Resource pool selection**');
  const step05 = skill.indexOf('**Step 0.5 — Stack-Selection Gate (MANDATORY)**');
  assert.ok(step0 !== -1 && step03 !== -1 && step0 < step03, 'Step 0.3 must follow Step 0');
  assert.ok(step05 !== -1 && step03 < step05, 'Step 0.3 must precede Step 0.5');
});

test('resource-pool reference documents the v3 mechanism, lifecycle, and error codes', () => {
  const resourcePool = readFileSync(referencePath, 'utf8');
  // The v3 snapshot must declare itself the successor of the #1071 caliber.
  assert.match(
    resourcePool,
    /# 两池沙箱资源池口径（v3，2026-11 定稿）/,
    'the reference must carry the v3 caliber heading',
  );
  assert.match(
    resourcePool,
    /本版合并并取代 #1071 旧口径（非持久 3h 固定 \/ 持久 14 天保留 \/ 三信号 \/ 关机前通知均已作废）/,
    'the successor statement must name the superseded #1071 doctrines',
  );
  // Mechanism: template IDs are server-authoritative; pool_type maps
  // server-side; no persist_mode parameter exists; instance-name prefixes
  // attribute the pool.
  assert.match(
    resourcePool,
    /池 = 平台预置模板\*\*：非持久 `9a108ab1bc354bc4979b949b36e3c8c1` \/ 持久 `05860f507ee94930844907a3a136d1a7` \/ flavor 3U6G `23ebdfe3b2d34cc4b34a1aaf03d27c54`（服务端 `POOL_TEMPLATE_\*` 环境变量维护）/,
    'the mechanism section must pin the template and flavor IDs with their env ownership',
  );
  assert.match(
    resourcePool,
    /客户端传 `pool_type`（ephemeral\/persistent），\*\*服务端权威映射\*\* template_id；显式 `template_id` 优先（自定义模板）/,
    'the client/server mapping split must be stated',
  );
  assert.match(
    resourcePool,
    /\*\*无 persist_mode 请求参数\*\*（需求方两次纠正）/,
    'the no-persist_mode fact must be stated',
  );
  assert.match(
    resourcePool,
    /实例名前缀即池归属：`hcdke\*`（非持久）\/ `hcdkp\*`（持久）；同池才复用/,
    'the instance-name prefix attribution must be stated',
  );
  // Type table: attribution pins with within-cell wildcards ([^|] cannot
  // cross a cell boundary), so a semantics-preserving reword stays green.
  assert.match(
    resourcePool,
    /\| 维度\s+\| 非持久化 \(ephemeral\)\s+\| 持久化 \(persistent\)/,
    'the type table columns must stay ephemeral-then-persistent',
  );
  assert.match(
    resourcePool,
    /\| 生命周期\s+\|\s*闲置 30min 自动关机 \+ 1h 删除（已实测）\s+\|\s*闲置回收保留期上限 7 天（资源组 DB 硬约束）\s*\|/,
    'the lifecycle row must keep 30min/1h on the ephemeral side and the 7-day cap on the persistent side',
  );
  assert.match(
    resourcePool,
    /\| 存储\s+\|\s*无持久盘\s+\|\s*挂 EVS 32G\s*\|/,
    'the EVS mount must stay on the persistent side',
  );
  // Absence pins (the paired-cell doctrine-leak class): the superseded
  // #1071 lifecycle doctrines must not survive anywhere as live doctrine.
  assert.doesNotMatch(
    resourcePool,
    /\| 生命周期\s+\|[^|]*固定 3h/,
    'the fixed-3h doctrine must not survive in the ephemeral cell',
  );
  assert.doesNotMatch(
    resourcePool,
    /\| 生命周期\s+\|[^|]*\|[^|]*14 天/,
    'the 14-day doctrine must not survive in the persistent cell',
  );
  // Lifecycle table (measured caliber): the status column pins what is
  // verified vs platform-side.
  assert.match(
    resourcePool,
    /\| 非持久闲置策略\s+\| 30min 自动关机 \+ 1h 删除（平台定时任务）\s+\|\s*✅ 已验证生效\s*\|/,
    'the ephemeral idle policy must be pinned as verified',
  );
  assert.match(
    resourcePool,
    /\| 持久闲置回收\s+\| 保留期上限 7 天（原 14 天口径作废）\s+\|\s*平台侧\s*\|/,
    'the persistent reclaim must be pinned with the 14-day supersession',
  );
  assert.match(
    resourcePool,
    /\| 活性检测\s+\| 当前仅 connect 单信号（三信号为后续诉求 G2）\s+\|\s*现状\s*\|/,
    'the activity-signal status must state the single-signal present state',
  );
  assert.match(
    resourcePool,
    /\| 删除\/关机前通知\s+\| 不支持（G6 诉求中）→ 客户端 TTL 播报为补偿方案\s+\|\s*现状\s*\|/,
    'the no-pre-shutdown-notice status must name the TTL broadcast as the compensation',
  );
  // Capacity planning rows (原始申请口径 with the 3U6G re-check note).
  assert.match(
    resourcePool,
    /\|\s*非持久化 2U4G\s+\|\s*1000 实例\s*\|/,
    'ephemeral 2U4G must be documented at 1000 instances',
  );
  assert.match(
    resourcePool,
    /\|\s*持久化 2U4G\s+\|\s*300 实例\s*\|/,
    'persistent 2U4G must be documented at 300 instances',
  );
  assert.match(
    resourcePool,
    /\|\s*持久化 4U8G\s+\|\s*200 实例\s*\|/,
    'persistent 4U8G must be documented at 200 instances',
  );
  assert.match(
    resourcePool,
    /\|\s*overlayer\s+\|\s*5 GB \/ 实例\s*\|/,
    'the overlayer row must carry the 5 GB per-instance quota',
  );
  assert.match(
    resourcePool,
    /\|\s*EVS（持久化挂盘）\s+\|\s*300 TB 总量\s*\|/,
    'the EVS row must carry the 300 TB total',
  );
  assert.match(
    resourcePool,
    /实际池 flavor 为 \*\*3U6G\*\*（需求方 2026-11-02 指定，尾号 54），上述 2U4G\/4U8G 为原始申请口径，容量数字需按 3U6G 重新核算/,
    'the 3U6G re-check note must stay attached to the original-application table',
  );
  // Quota and error codes: the per-type quota, account cap, dual 429 codes
  // with upstream code mappings, and the burn-core code.
  assert.match(
    resourcePool,
    /每用户每类型 1 台（同类复用，ephemeral \+ persistent 可并存 1\+1）；账号并发上限 5/,
    'the quota bullet must restate the 1+1 model with the account cap',
  );
  assert.match(
    resourcePool,
    /`HDKIT_QUOTA_EXCEEDED`：用户配额满（上游 `HD\.98320022`）→ 重试无效，引导释放\/复用已有实例/,
    'quota-exceeded must map to its upstream code and release/reuse remedy',
  );
  assert.match(
    resourcePool,
    /`HDKIT_CAPACITY_INSUFFICIENT`：池容量不足（上游 `HD\.99003001`\/`HD\.99008001`\/`HD\.98330021`）→ 建议错峰重试/,
    'capacity-insufficient must map to its upstream codes and off-peak remedy',
  );
  assert.match(
    resourcePool,
    /烧核：`HD\.97520422` = 账号核心时长耗尽（沙箱运行消耗核时；客户端对含该码的错误输出友好播报）/,
    'the burn-core code must map to its exhaustion meaning and friendly-broadcast duty',
  );
  assert.match(
    resourcePool,
    /沙箱消耗核时（烧核）时向用户播报：核时来源于\*\*平台赠送 \+ 活动赚取\*\*（非直接计费口径）/,
    'the burn sentence must be pinned from its duty lead through the gifting compound',
  );
  // Client behavior section (this plugin's contract).
  assert.match(
    resourcePool,
    /`sandbox_connect` 传 `pool_type`；非法值本地即报错（不发无效请求）；未传由服务端默认 ephemeral/,
    'the client must validate pool_type locally and defer absence to the server',
  );
  assert.match(
    resourcePool,
    /connect 返回值富化 `pool` 块（TTL 播报，仅服务端回显 pool_type 时）；exec\/upload\/deploy\/expose 返回值带 `poolMode`\/`persistenceHint`/,
    'the enrichment surfaces must be stated with their echo-only condition',
  );
  assert.match(
    resourcePool,
    /钉扎（可选，运维场景）：`HW_POOL_TEMPLATE_EPHEMERAL`\/`HW_POOL_TEMPLATE_PERSISTENT` 环境变量——设置后客户端附带映射 template_id 上送；日常部署无需配置（模板 ID 由服务端权威维护）/,
    'the pinning contract must be stated with its optional-ops posture',
  );
  // G list: G1's mapping drives the 7-day cap the deletion doctrine cites.
  assert.match(
    resourcePool,
    /- G1 闲置删除策略配置（资源组，驱动 7 天上限回收）\n- G2/,
    'the reference G1 mapping must be pinned in full',
  );
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    assert.match(resourcePool, new RegExp(`${g} `), `platform dependency ${g} must be mirrored`);
  }
  assert.match(
    resourcePool,
    /^## 平台侧关键依赖（G 清单，非 devkit 交付）$/m,
    'the reference G-list heading must keep its not-devkit-delivery posture',
  );
  // Known boundaries: the whitelist-conditional honesty note (dev 805f24ba)
  // leads the list ahead of the untested-upstream note.
  const whitelist = resourcePool.indexOf(
    '池模板当前为**白名单条件实测**（仅对测试账号加白），公开上线后需复测模板 ID 与口径',
  );
  assert.ok(
    whitelist !== -1,
    'the known-boundary list must keep the whitelist-conditional template recalibration duty',
  );
  assert.match(
    resourcePool,
    /上游 429 真实响应结构未实测：服务端映射先按已知错误码实现，联调实测后校准/,
    'the known-boundary note must keep the untested-upstream honesty',
  );
  const untested429 = resourcePool.indexOf('上游 429 真实响应结构未实测');
  assert.ok(whitelist < untested429, 'the whitelist note must lead the known-boundary list');

  // The skill's own tool-summary table and References link (v2-wins sync:
  // they follow the ported doctrine).
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(
    skill,
    /Connect to sandbox \(one instance per user per pool; `pool_type` selects ephemeral\/persistent, default ephemeral\)\s*\|/,
    'the tool table must state the pool_type selection model',
  );
  assert.match(
    skill,
    /- \[Resource Pool\]\(references\/resource-pool\.md\) — 资源池定稿口径/,
    'the References list must link the resource-pool reference',
  );
  // The late-flow catch-all surface: the warnings table carries the pool row
  // beside the two gate rows (the #1021 v2-wins precedent — the table is the
  // surface an agent consults last). The v2-authored row is the one surface
  // with no verbatim dev source of truth, so its doctrine body is pinned in
  // its reconciled v3 form: the 429 dual-code discriminator, the routing
  // tails, the lifecycle facts, and the gate sentence.
  const warningsRow = skill.split('\n').find((line) => line.includes('Pool type fixes durability')) ?? '';
  assert.match(
    warningsRow,
    /预览\/试用\/即焚 requests belong on the `ephemeral` pool — idle 30min auto-shutdown \+ 1h auto-delete \(平台定时任务，已实测\), nothing survives it, data dies with the box; 工作台\/带数据库\/跨日 requests belong on the `persistent` pool \(EVS 32G mounted, survives reboots, idle reclaim within 7 days max\)\./,
    'the warnings row must route each intent family to its pool with the v3 lifecycle facts',
  );
  assert.match(
    warningsRow,
    /Pick per the 两池沙箱（pool_type） selection rules \(Step 0\.3\) BEFORE calling `sandbox_connect`, and never promise durability on an ephemeral sandbox\./,
    'the warnings row must carry the Step 0.3 gate sentence',
  );
  assert.match(
    warningsRow,
    /A rejected connect returns HTTP 429 with a Retry-After header and a dual error code — the CODE, not the status, separates the two failure classes: HDKIT_QUOTA_EXCEEDED \(quota — 1 instance per pool type; release or reuse, retry useless\) vs HDKIT_CAPACITY_INSUFFICIENT \(pool capacity; retry later \/ off-peak\)\./,
    'the warnings row must state the full 429 dual-code arrival contract',
  );
});

test('sandbox tool descriptions carry the pool_type and 429 dual-code semantics (v3 caliber)', () => {
  const tools = readFileSync(toolsPath, 'utf8');

  const connectDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_connect');
  assert.match(
    connectDesc,
    /One instance per user per pool — reuses the same-pool sandbox if available, otherwise creates a new one\./,
    'connect must state the full per-pool reuse sentence',
  );
  assert.match(
    connectDesc,
    /Quota: 1 instance per pool type \(a user may hold 1 ephemeral AND 1 persistent simultaneously; same-type requests reuse the existing instance\)\./,
    'connect must state the per-type quota',
  );
  assert.match(
    connectDesc,
    /On quota exhaustion the API returns HTTP 429 with a Retry-After header and a dual error code: HDKIT_QUOTA_EXCEEDED \(retry useless — release or reuse the existing instance\) vs HDKIT_CAPACITY_INSUFFICIENT \(pool capacity; retry later \/ off-peak\)\./,
    'connect must state the full 429 arrival and dual-code-to-remedy contract',
  );
  // Mapping-bearing pins on the description's own lifecycle attribution —
  // the connect description is the surface an agent sees without loading
  // the skill, so its lifecycle facts must not silently contradict the
  // skill's pinned tables (a swap between the two types must red the gate).
  assert.match(
    connectDesc,
    /Ephemeral pool \(default\): idle auto-shutdown after 30min, auto-delete after 1h — do not keep important data there\./,
    'the connect description must attribute the 30min/1h lifecycle to the ephemeral pool',
  );
  assert.match(
    connectDesc,
    /Persistent pool: data disk retained \(EVS 32G\), idle reclaim capped at 7 days\./,
    'the connect description must attribute the EVS retention and 7-day cap to the persistent pool',
  );
  assert.match(
    connectDesc,
    /pool_type\/template_id echo/,
    'the connect description must promise the pool_type/template_id echo',
  );
  // v2 divergence: the vendor-gate seam stays on the connect description.
  assert.match(connectDesc, /Vendor-gated \(vendorConfirmed\)/, 'connect must keep the vendor-gate sentence');

  const closeDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_close_session');
  assert.match(
    closeDesc,
    /This closes the agent-side terminal session only — it does NOT delete the sandbox instance\./,
    'close_session must state the terminal-only scope before the no-delete disclaimer (dev pin)',
  );
  assert.match(
    closeDesc,
    /Resource-pool sandbox deletion is developer-initiated \(always ask for a second confirmation before guiding a delete\) or handled by the platform resource-group idle-reclaim policy within the 7-day cap \(v3 caliber\); devkit never defers or performs deletion on the user behalf\./,
    'close_session must state the full deletion-attribution sentence with the 7-day cap (v3 caliber)',
  );
  // Absence pins: the superseded #1071 calibers must not survive on any of
  // the three pinned surfaces.
  for (const [label, surface] of [
    ['connect description', connectDesc],
    ['close_session description', closeDesc],
  ] as const) {
    assert.doesNotMatch(
      surface,
      /fixed 3h|3h from CreateTime/,
      `the fixed-3h doctrine must not survive in the ${label}`,
    );
    assert.doesNotMatch(surface, /14-day retention|14 days/, `the 14-day doctrine must not survive in the ${label}`);
  }
});

test('connect schema documents the pool_type parameter with its lifecycle semantics', () => {
  const schemas = readFileSync(join(pluginRoot, 'src', 'packs', 'sandbox', 'schemas.ts'), 'utf8');
  const connectSchemaBlock = schemas.slice(
    schemas.indexOf('export const connectSchema'),
    schemas.indexOf('export const credentialsSchema'),
  );
  assert.match(
    connectSchemaBlock,
    /pool_type: z\s*\.enum\(\['ephemeral', 'persistent'\]\)/,
    'connectSchema must declare the pool_type enum',
  );
  assert.match(
    connectSchemaBlock,
    /Sandbox pool type \(default ephemeral\)\. ephemeral = non-persistent: idle auto-shutdown 30min \+ auto-delete 1h \(platform scheduled task, verified\) — save important data elsewhere; persistent = data disk retained, idle reclaim within 7 days\./,
    'the pool_type description must state both lifecycle calibers',
  );
  assert.match(
    connectSchemaBlock,
    /Explicit template_id overrides pool_type\./,
    'the pool_type description must state the explicit-template precedence',
  );
});
