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
  // 口径基调 blockquote（dev 5c09d225 终态）：实测基调声明必须以块引用形态先于
  // 本节一切表格（口头支持不作数——数值为服务端配置下发的默认口径，平台调参以回显为准）。
  const caliber =
    /^> 口径基调：一切以实测为准，口头支持不作数（下表生命周期为实测\/平台侧现状；数值为服务端配置下发的默认口径，平台调参以服务端回显为准）。$/m.exec(
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
    /\| `persistent`\s+\| 持久沙箱（EVS 盘）\s+\| 数据跨关机保留；闲置 1 小时自动关机；闲置回收保留期上限 7 天\s+\| 需要跨会话保留数据\s*\|/,
    'the type table must keep the persistent row with the 1h idle shutdown and the 7-day reclaim cap',
  );
  // Selection-rules table rows: intent → pool_type mapping with the reason.
  // dev b1ab4029 (PR-5): the DB row splits by intent — a DB-backed PREVIEW
  // routes to ephemeral (stack is not a persistence trigger), only
  // DB-with-cross-session-data-retention routes to persistent.
  for (const [intent, poolType] of [
    ['预览 / 试用 / demo', 'ephemeral'],
    ['一次性任务（跑完即弃）', 'ephemeral'],
    ['敏感内容（即焚）', 'ephemeral'],
    ['带数据库但只是预览/演示', 'ephemeral'],
    ['开发工作台 / workbench', 'persistent'],
    ['带数据库且需要跨会话保留数据', 'persistent'],
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
    ['带数据库但只是预览/演示', 'persistent'],
    ['开发工作台 / workbench', 'ephemeral'],
    ['带数据库且需要跨会话保留数据', 'ephemeral'],
    ['跨日评审 / 展示', 'ephemeral'],
  ] as const) {
    assert.doesNotMatch(
      poolSection,
      new RegExp(`\\|\\s*${intent}\\s+\\|\\s*${wrongType}\\s+\\|`),
      `${intent} must never route to ${wrongType}`,
    );
  }
  // The superseded DB-implies-persistent row must not survive anywhere in
  // the section (the gate's never-rule 1 in table form).
  assert.doesNotMatch(
    poolSection,
    /\|\s*带数据库项目（DB-backed）\s*\|/,
    'the old DB-backed-implies-persistent row must not survive',
  );
  // The four gate-restatement bullets that follow the table (dev b1ab4029):
  // the compact doctrine the pool-section reader meets before the full gate.
  assert.match(poolSection, /预览\/一次性即使全栈\/DB 也用 `ephemeral`\*\*；技术栈不是持久化触发器/);
  assert.match(
    poolSection,
    /`persistent` 只能来自明确长期意图，或推断后确认\*\*；不得仅因 full-stack\/DB 选 persistent/,
  );
  assert.match(
    poolSection,
    /同一任务沿用当前池\*\*；新任务重新选型；新预览默认 `ephemeral`，必要时问一次是否复用已有 persistent/,
  );
  assert.match(poolSection, /切换池数据不迁移\*\*\n/);
  // Selection-rule leads: the selection defers to the gate (dev b1ab4029) —
  // auto-select by intent with developer override, gate-executed, default
  // ephemeral. The old intent-unclear-present-both lead is superseded by the
  // gate's ask-once question with the ephemeral default.
  assert.match(
    poolSection,
    /Selection rules（按意图自动选池；具体按 \[Pool-Selection Gate\]\(#pool-selection-gate-mandatory--do-not-skip\) 执行；默认 `ephemeral`，`persistent` 需明确长期意图或确认；开发者可覆盖）：/,
    'the selection rules must defer to the Pool-Selection Gate with the ephemeral default',
  );
  assert.doesNotMatch(
    poolSection,
    /意图不明确时呈现两类供选择/,
    'the pre-gate present-both-classes posture must not survive',
  );
  assert.match(
    poolSection,
    /\*\*配额\*\*：每用户每类型 1 台（1\+1 可并存）；同池 connect 自动复用已有实例/,
    'the per-type quota bullet must state the 1+1 model with same-pool reuse',
  );
  // The 429 three-code doctrine (dev 45dd4f99 终态；PR-7): each code with its
  // own remedy, and the Retry-After split (quota/capacity carry it, template
  // quota does not) — a code-to-remedy swap or a Retry-After collapse reds the
  // gate.
  // dev 5c09d225 终态：capacity 由服务端返回最终文案，客户端不再附加引导。
  assert.match(
    poolSection,
    /\*\*429 三错误码\*\*：`HDKIT_QUOTA_EXCEEDED`（账号配额满，重试无效→引导释放\/复用）；`HDKIT_TEMPLATE_QUOTA_EXCEEDED`（当前账号此类型沙箱运行中实例达上限，需关机\/释放同类型实例后重试，无 `Retry-After`）；`HDKIT_CAPACITY_INSUFFICIENT`（池容量不足，服务端直接返回最终文案“DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！”，客户端不再附加引导）。`HDKIT_QUOTA_EXCEEDED` \/ `HDKIT_CAPACITY_INSUFFICIENT` 响应带 `Retry-After: 60`/,
    'the 429 three-code bullet must map each code to its distinct remedy with the per-code Retry-After split',
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
  assert.doesNotMatch(
    poolSection,
    /HDKIT_TEMPLATE_QUOTA_EXCEEDED`（账号配额满/,
    'template-quota-exceeded must never carry the account-quota remedy',
  );
  assert.doesNotMatch(
    poolSection,
    /HDKIT_TEMPLATE_QUOTA_EXCEEDED`（池容量不足/,
    'template-quota-exceeded must never carry the capacity remedy',
  );
  assert.doesNotMatch(
    poolSection,
    /HDKIT_CAPACITY_INSUFFICIENT`（当前账号此类型沙箱/,
    'capacity-insufficient must never carry the template-quota remedy',
  );
  assert.doesNotMatch(
    poolSection,
    /HDKIT_CAPACITY_INSUFFICIENT`（池容量不足→建议错峰重试/,
    'the client-side off-peak remediation must not survive (server copy is final)',
  );
  // dev dff5df91: the old account-level guidance ("每账号最多 5 台") must not
  // ride the template-quota sentence — it names the wrong cap.
  assert.doesNotMatch(
    poolSection,
    /HDKIT_TEMPLATE_QUOTA_EXCEEDED`（[^）]*每账号最多 5 台/,
    'the superseded account-level quota guidance must not ride the template-quota sentence',
  );
  // TTL broadcast duty (dev 5c09d225 终态)：播报只出现在 connect（首次/唤醒）与
  // expose_tunnel 两个时机；URL 交付时必须转述 urlLifetimeHint/warnings。
  assert.match(
    poolSection,
    /\*\*TTL 播报\*\*：仅 connect（会话首次连接 \/ 复用被唤醒 `started=true`）与 expose_tunnel（交付地址时）返回生命周期提示；其余执行类工具不逐次播报。\*\*ephemeral 池部署的公网地址会随沙箱闲置关机失效\*\*，向开发者交付 URL 时必须转述 `urlLifetimeHint` \/ `warnings` 中的存活期提示（隧道有效期 ≠ 沙箱存活期）。数值以服务端回显为准，缺失时用默认口径兜底$/m,
    'the TTL broadcast bullet must pin the two announce occasions and the MUST-relay duty (line-anchored: appended rewordings cannot hide behind this pin)',
  );
  assert.doesNotMatch(
    poolSection,
    /\*\*TTL 播报\*\*：connect 与执行类工具返回值带池模式/,
    'the per-call pool-context broadcast doctrine must not survive',
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

test('workflow sequences the pool gate (Step 0.6) after the stack gate (port-pr5)', () => {
  const skill = readFileSync(skillPath, 'utf8');

  // dev b1ab4029 reorder: the pool choice follows the stack gate (the stack
  // is known before the pool is picked) and defers to the gate doctrine —
  // position, not just presence: after the target gate resolves, the stack
  // gate opens code transfer, then the pool choice is gated and checked
  // against the lifecycle window.
  assert.match(
    skill,
    /\*\*Step 0\.6 — Pool-Selection Gate \(MANDATORY\)\*\*: once the target is sandbox and the stack is known, select the pool per the \[Pool-Selection Gate\]\(#pool-selection-gate-mandatory--do-not-skip\)\. Default `ephemeral`; use `persistent` only with explicit long-term intent or after confirmation\. Same task reuses the current pool; a new task is re-evaluated\. Check the task survives the chosen type's lifecycle window \(ephemeral: idle 30min shutdown \+ 1h delete; persistent: 7-day idle reclaim cap\) before connecting\./,
    'Step 0.6 must link the gate at its real heading anchor with the lifecycle window',
  );
  const step0 = skill.indexOf('**Step 0 — Target-Selection Gate (MANDATORY)**');
  const step05 = skill.indexOf('**Step 0.5 — Stack-Selection Gate (MANDATORY)**');
  const step06 = skill.indexOf('**Step 0.6 — Pool-Selection Gate (MANDATORY)**');
  assert.ok(step0 !== -1 && step05 !== -1 && step0 < step05, 'Step 0.5 must follow Step 0');
  assert.ok(step06 !== -1 && step05 < step06, 'Step 0.6 must follow Step 0.5 (stack before pool, dev b1ab4029)');
  assert.equal(
    skill.includes('**Step 0.3 — Resource pool selection**'),
    false,
    'the pre-stack pool-selection step must not survive',
  );

  // Step 10 的 URL 交付纪律（dev 5c09d225）：每次交付 URL 必须附带 sandbox 存活期提示。
  assert.match(
    skill,
    /\*\*Every URL handoff MUST include the sandbox-lifetime notice from `urlLifetimeHint` \(or `warnings`\)\*\*: the address dies when the sandbox idles out \(ephemeral: shutdown\/delete; persistent: shutdown, data retained\), and the tunnel expiry is not the sandbox lifetime/,
    'Step 10 must carry the URL-handoff MUST-relay duty with both pool lifetimes',
  );
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
  // dev b1ab4029 (PR-5): the attribution row drops DB-as-a-trigger from the
  // persistent side and scopes it to cross-session data retention.
  assert.match(
    resourcePool,
    /\| 定位\s+\| 预览\/试用\/一次性任务\/敏感即焚（含全栈\/DB 预览）\s+\| 开发工作台\/需要跨会话保留数据的项目\/跨日评审展示\s*\|/,
    'the attribution row must route DB previews to ephemeral and persistent to cross-session retention',
  );
  assert.match(
    resourcePool,
    /\| 生命周期\s+\|\s*闲置 30min 自动关机 \+ 1h 删除（已实测）\s+\|\s*闲置 1h 自动关机（实例与数据保留）；回收上限 7 天（资源组 DB 硬约束）\s*\|/,
    'the lifecycle row must keep 30min/1h on the ephemeral side and the 1h-shutdown/7-day cap on the persistent side',
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
  // verified vs platform-side. dev 5c09d225 增补持久闲置策略行 + 播报口径引用块。
  assert.match(
    resourcePool,
    /\| 非持久闲置策略\s+\| 30min 自动关机 \+ 1h 删除（平台定时任务）\s+\|\s*✅ 已验证生效\s*\|/,
    'the ephemeral idle policy must be pinned as verified',
  );
  assert.match(
    resourcePool,
    /\| 持久闲置策略\s+\| 闲置 1h 自动关机（实例与数据盘保留）\s+\|\s*平台侧\s*\|/,
    'the persistent idle-shutdown row must be pinned as platform-side',
  );
  assert.match(
    resourcePool,
    /> 生命周期数值是\*\*播报口径\*\*，由 hdkitservice 配置（`POOL_EPHEMERAL_IDLE_SHUTDOWN_MINUTES` \/ `POOL_EPHEMERAL_IDLE_DELETE_MINUTES` \/ `POOL_PERSISTENT_IDLE_SHUTDOWN_MINUTES` \/ `POOL_PERSISTENT_RECLAIM_MINUTES`，统一以\*\*分钟\*\*为单位；7 天 = 10080）随 connect 响应回显；客户端以回显为准，缺失时按上表默认值兜底。实际关机\/删除策略由平台资源池执行，hdkitservice 不控制。$/m,
    'the broadcast-caliber blockquote must pin the minute-based env contract (RECLAIM_MINUTES, 7 天 = 10080; line-anchored: appended rewordings cannot hide behind this pin)',
  );
  assert.doesNotMatch(
    resourcePool,
    /POOL_PERSISTENT_RECLAIM_DAYS/,
    'the day-based reclaim env must not survive (minute-based per ef9e977b)',
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
  // Quota and error codes: the per-type quota, account cap, three 429 codes
  // with upstream code mappings, and the burn-core code. PR-7 adds the
  // template-level running cap (HD.98320082) as the third code.
  assert.match(
    resourcePool,
    /每用户每类型 1 台（同类复用，ephemeral \+ persistent 可并存 1\+1）；账号并发上限 5/,
    'the quota bullet must restate the 1+1 model with the account cap',
  );
  assert.match(
    resourcePool,
    /429 三错误码（`HDKIT_QUOTA_EXCEEDED` \/ `HDKIT_CAPACITY_INSUFFICIENT` 带 `Retry-After: 60`；`HDKIT_TEMPLATE_QUOTA_EXCEEDED` 不带）：/,
    'the 429 code block must carry the per-code Retry-After split',
  );
  assert.match(
    resourcePool,
    /`HDKIT_QUOTA_EXCEEDED`：用户配额满（上游 `HD\.98320022`）→ 重试无效，引导释放\/复用已有实例/,
    'quota-exceeded must map to its upstream code and release/reuse remedy',
  );
  assert.match(
    resourcePool,
    /`HDKIT_TEMPLATE_QUOTA_EXCEEDED`：当前账号此类型沙箱运行中实例达上限（上游 `HD\.98320082`）→ 需关机\/释放同类型实例后重试/,
    'template-quota-exceeded must map to its upstream code and the same-type free-up remedy',
  );
  assert.match(
    resourcePool,
    /`HDKIT_CAPACITY_INSUFFICIENT`：池容量不足（上游 `HD\.99003001`\/`HD\.99008001`\/`HD\.98330021`）→ 服务端直接返回最终文案“DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！”，客户端原样透传不再附加引导/,
    'capacity-insufficient must map to its upstream codes and the server-final copy passthrough',
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
  // dev b1ab4029: the selection belongs to the skill's gate; the client only
  // validates and passes pool_type through.
  assert.match(
    resourcePool,
    /选型由 skill 的 Pool-Selection Gate 决定；客户端只校验\/透传 `pool_type`，不自行推断/,
    'the client contract must defer selection to the skill gate',
  );
  // dev 5c09d225 终态客户端行为：播报时机两处、口径落盘缓存、429 差异化透传。
  assert.match(
    resourcePool,
    /生命周期提示只在两个时机播报：connect（会话首次连接，或复用实例被唤醒 `started=true`）与 `expose_tunnel`（交付地址时，返回 `urlLifetimeHint` \+ `warnings`）；其余 exec\/upload\/deploy 工具不逐次播报/,
    'the two announce occasions must be stated with the expose-tunnel relay surface',
  );
  assert.match(
    resourcePool,
    /connect 返回值富化 `pool` 块（数值取服务端回显，缺失时用默认口径）；生命周期口径按 workspace 缓存到 `~\/\.config\/huaweicloud\/sandbox-pools\.json`（0600，7 天过期），进程重启后仍可播报/,
    'the pool-block enrichment and the 0600 7-day cache contract must be stated',
  );
  assert.match(
    resourcePool,
    /429：配额满与模板配额满给 `remediation` 引导；容量不足只透传服务端最终文案 \+ `retryAfter`；模板配额不带 `retryAfter`/,
    'the 429 split must pin quota/template-quota remediation vs capacity passthrough',
  );
  assert.doesNotMatch(
    resourcePool,
    /exec\/upload\/deploy\/expose 返回值带 `poolMode`\/`persistenceHint`/,
    'the per-call poolMode/persistenceHint doctrine must not survive',
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
  // its reconciled v3 form: the 429 three-code discriminator, the routing
  // tails, the lifecycle facts, and the gate sentence.
  const warningsRow = skill.split('\n').find((line) => line.includes('Pool type fixes durability')) ?? '';
  assert.match(
    warningsRow,
    /预览\/试用\/即焚 requests belong on the `ephemeral` pool — idle 30min auto-shutdown \+ 1h auto-delete \(平台定时任务，已实测\), nothing survives it, data dies with the box; 工作台\/需要跨会话保留数据\/跨日 requests belong on the `persistent` pool \(EVS 32G mounted, survives reboots, idle reclaim within 7 days max\)\./,
    'the warnings row must route each intent family to its pool with the v3 lifecycle facts (port-pr5: DB alone is not a persistent trigger)',
  );
  assert.match(
    warningsRow,
    /Pick per the \[Pool-Selection Gate\]\(#pool-selection-gate-mandatory--do-not-skip\) \(Step 0\.6\) BEFORE calling `sandbox_connect`, and never promise durability on an ephemeral sandbox\./,
    'the warnings row must carry the Pool-Selection Gate sentence (Step 0.6)',
  );
  assert.match(
    warningsRow,
    /A rejected connect returns HTTP 429 with one of three codes — the CODE, not the status, separates the failure classes: HDKIT_QUOTA_EXCEEDED \(quota — 1 instance per pool type; release or reuse, retry useless; Retry-After 60\), HDKIT_TEMPLATE_QUOTA_EXCEEDED \(the running instances of this account for this sandbox type are at the limit — shut down or release an instance of the same type and retry; no Retry-After\), or HDKIT_CAPACITY_INSUFFICIENT \(pool capacity; retry later \/ off-peak; Retry-After 60\)\./,
    'the warnings row must state the full 429 three-code arrival contract with its per-code remedies',
  );
  assert.doesNotMatch(
    warningsRow,
    /dual error code/,
    'the superseded dual-code wording must not survive in the warnings row (PR-7)',
  );
  // dev e0c8700b + 501fd8b4 + e1255a4b 的门禁/重试 doctrine 行（v2 自著面）：
  // 502/504 与 409 两类相反处置钉在同一行，互换即红门；autoUpgrade 不存活
  // （dev 的自动升级模块未移植——替换措辞的缺位钉）。
  const gateWarningsRow =
    skill.split('\n').find((line) => line.includes('Gateway 502/504 vs the 409 version gate')) ?? '';
  assert.match(
    gateWarningsRow,
    /A connect answered by gateway 502\/504 is a transient orchestration timeout, NOT a failed create: Gateway 502\/504 timeouts during orchestration are retried automatically \(30s\/45s backoff\) — the server may already have created the instance, so a retry reuses it; on exhaustion the result is ok:false with the attempt count, and the remediation follows the failing answer — a gateway page carries the transient-class copy, while a business-coded 502 that carries its own remediation keeps it \(one without its own copy falls to the transient copy\)\./,
    'the gate warnings row must mirror the retry sentence with the exhaustion observable and the exact remediation-split rule',
  );
  assert.match(
    gateWarningsRow,
    /The same gate fires on the expose relay's auto-create, surfacing error_code HDKIT_VERSION_TOO_OLD with the upgrade remediation instead of a credential failure\./,
    'the gate warnings row must pin the relay fold observable',
  );
  // Step 1 NO_CREDENTIAL 判别（门禁子弹先于配额/兜底引导）：被门禁的客户端
  // 不再被引去清 key/重注凭证（与警告行"Do not debug either as a credential
  // issue"互为印证）
  assert.match(
    skill,
    /\*\*Version gate\*\* \(`HDKIT_VERSION_TOO_OLD`\): NOT a credential problem — the plugin version is too old\. The failure carries the upgrade remediation under gateRemediation \(npx --yes huaweicloud-devkit@latest update --target <agent>, restart the agent session, or call `huaweicloud_upgrade`\); creating a key or re-running `huaweicloud_sandbox_credentials` cannot clear it\./,
    'the Step 1 NO_CREDENTIAL branch must discriminate the version gate before the quota and manual fallbacks, with the taught field name gateRemediation',
  );
  assert.match(
    gateWarningsRow,
    /A 409 `HDKIT_VERSION_TOO_OLD` is the client-version gate — a different failure, not transient: follow the returned remediation \(npx --yes huaweicloud-devkit@latest update --target <agent>, restart the agent session, or call `huaweicloud_upgrade`\); retrying connect cannot clear it\./,
    'the gate warnings row must pin the 409-to-upgrade mapping with the non-retryable verdict',
  );
  assert.doesNotMatch(
    gateWarningsRow,
    /autoUpgrade|自动升级/,
    'the dev autoUpgrade field must not survive in the warnings row (the auto-upgrade module is not ported)',
  );
});

test('sandbox tool descriptions carry the pool_type and 429 three-code semantics (v3 caliber + PR-7)', () => {
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
    /On quota exhaustion the API returns HTTP 429 with one of three codes: HDKIT_QUOTA_EXCEEDED \(retry useless — release or reuse the existing instance; Retry-After 60\), HDKIT_TEMPLATE_QUOTA_EXCEEDED \(the running instances of this account for this sandbox type are at the limit — shut down or release an instance of the same type and retry; no Retry-After\), or HDKIT_CAPACITY_INSUFFICIENT \(pool capacity; retry later \/ off-peak; Retry-After 60\)\./,
    'connect must state the full 429 arrival and the three-code-to-remedy contract',
  );
  assert.doesNotMatch(
    connectDesc,
    /dual error code/,
    'the superseded dual-code wording must not survive on the connect description (PR-7)',
  );
  // dev e0c8700b + 501fd8b4 + e1255a4b：网关 502/504 有界重试与 409 版本门禁。
  // 映射承载钉：502/504 → 瞬时重试+复用语义；409 → 门禁+升级引导——两类相反
  // 处置各钉其句，互换即红门。autoUpgrade 不存活（dev 的自动升级模块未移植）。
  assert.match(
    connectDesc,
    /Gateway 502\/504 timeouts during orchestration are retried automatically \(30s\/45s backoff\) — the server may already have created the instance, so a retry reuses it\./,
    'connect must state the bounded gateway retry with the reuse fact',
  );
  assert.match(
    connectDesc,
    /An outdated plugin version is rejected by the 409 HDKIT_VERSION_TOO_OLD version gate, surfaced by the sandbox tools \(connect\/check_user\/sign_agreement\/credentials\) as ok:false and by the voucher trio as claimed:false, always carrying code, message, and remediation naming the upgrade act \(npx --yes huaweicloud-devkit@latest update --target <agent>, restart the agent session, or huaweicloud_upgrade\), with clientVersion and minVersion present when the service sends them\./,
    'connect must state the version-gate arrival with the split ok/claimed envelopes, the always-present fields, and the version fields as service-conditional',
  );
  assert.doesNotMatch(
    connectDesc,
    /autoUpgrade|自动升级/,
    'the dev autoUpgrade field must not survive on the connect description (the auto-upgrade module is not ported)',
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
    /Persistent pool: data disk retained \(EVS 32G\), idle shutdown after 1h, idle reclaim capped at 7 days\./,
    'the connect description must attribute the EVS retention, 1h shutdown, and 7-day cap to the persistent pool',
  );
  // dev 5c09d225/ef9e977b 终态：服务端配置字段（分钟口径）、started 字段、播报时机。
  assert.match(
    connectDesc,
    /pool_type\/template_id echo, server-configured lifecycle numbers \(pool_idle_shutdown_minutes \/ pool_idle_delete_minutes \/ pool_reclaim_minutes\) and started \(true when a reused instance was woken from shutdown\)\./,
    'the connect description must promise the server-configured minute-based lifecycle echo and the started field',
  );
  assert.match(
    connectDesc,
    /Lifecycle hints are announced only on the first connect of a session or when started=true\./,
    'the connect description must pin the announce occasions',
  );
  assert.match(
    connectDesc,
    /Numbers are configured by hdkitservice; the text follows the server echo and falls back to these defaults\./,
    'the connect description must state the server-echo-first fallback doctrine',
  );
  assert.match(
    connectDesc,
    /pool_type\/template_id echo/,
    'the connect description must promise the pool_type/template_id echo',
  );
  // v2 divergence: the vendor-gate seam stays on the connect description.
  assert.match(connectDesc, /Vendor-gated \(vendorConfirmed\)/, 'connect must keep the vendor-gate sentence');

  // dev 5c09d225 终态：expose 返回 sandboxLifetime/urlLifetimeHint 且 MUST-relay。
  const exposeDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_expose_tunnel');
  assert.match(
    exposeDesc,
    /keepalive\.enrolled\/tunnelCount\/watchdogPid, warnings, sandboxLifetime and urlLifetimeHint\./,
    'the expose description must promise the sandboxLifetime and urlLifetimeHint fields',
  );
  assert.match(
    exposeDesc,
    /The urlLifetimeHint MUST be relayed to the developer together with the URL: the tunnel expiry is NOT the sandbox lifetime — an idle sandbox shuts down \(ephemeral also auto-deletes\), which kills the URL\./,
    'the expose description must carry the MUST-relay sentence',
  );
  assert.match(
    exposeDesc,
    /The auto-create relay goes through hdkitservice and inherits its 409 HDKIT_VERSION_TOO_OLD version gate: an outdated plugin fails auto-create the same way it fails connect, and the expose failure carries error_code HDKIT_VERSION_TOO_OLD with the upgrade remediation under gateRemediation, and clientVersion and minVersion when the service sends them — upgrade the plugin instead of creating a key by hand\./,
    'the expose description must teach the relay gate fold with its taught field name gateRemediation and the versions as service-conditional',
  );

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

test('huawei-sandbox teaches the shutdown doctrine and the persistent core-hours hint (port-pr6)', () => {
  // dev 5d89c880 + 3bfc1f53 移植的教义面：关机纪律（仅明确要求时调用、
  // close ≠ delete、非持久化也可关机但不主动提示）、persistent 播报的核时
  // 提醒、工具表与选型表的关机行、以及审批门第九个成员的教义同步。v2 的
  // TTL 播报行带行尾锚（见上 test 的 line-anchored pin），核时提醒因此落为
  // 独立 bullet，而非 dev 的行内追加——语义同源，形态 v2 适配。
  const skill = readFileSync(skillPath, 'utf8');
  const resourcePool = readFileSync(referencePath, 'utf8');
  const approvals = readFileSync(
    join(pluginRoot, 'src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'references', 'approvals.md'),
    'utf8',
  );

  // 关机纪律（dev 逐字）：仅明确要求、调用前确认一次、绝不自动关机；
  // 关机 ≠ 删除；非持久化也可关机但不主动提示；不提“控制台关机”。
  assert.match(
    skill,
    /\*\*关机纪律\*\*：仅当开发者明确要求关机时调用 `huaweicloud_sandbox_shutdown`；调用前确认一次，绝不自动关机。关机 ≠ 删除：只 close，不 delete，实例与 EVS 数据盘保留，下次 connect 自动唤醒。非持久化沙箱也可关机，但不主动提示；不要向开发者提“控制台关机”。/,
    'the shutdown-discipline bullet must pin the explicit-request-only contract and the close-not-delete fact',
  );

  // 核时提醒（v2 适配形态，独立 bullet）：persistent 播报追加，ephemeral 不出现。
  assert.match(
    skill,
    /\*\*核时提醒（persistent 播报追加）\*\*：persistent 池的生命周期播报（connect 的 `pool\.ttl_hint` 与 expose_tunnel 的 `urlLifetimeHint`）追加「如暂时不需要使用，建议尽快关机，避免持续消耗核时；可以告诉我帮你关机（实例与数据盘保留，下次连接会自动唤醒）。」；ephemeral 播报不出现该提示/,
    'the core-hours hint bullet must pin the persistent-only carriage and the hint text',
  );

  // 工具表与选型表的关机行（dev 逐字）。
  assert.match(
    skill,
    /\| `huaweicloud_sandbox_shutdown`\s+\| Shut down a running sandbox \(close only; instance\/data disk retained; reconnect wakes it\)/,
    'the lifecycle tool table must carry the shutdown row',
  );
  assert.match(
    skill,
    /\| 暂不使用 \/ 节省核时\s+\| `sandbox_shutdown`\s+\| 只关机不删除；数据盘保留，下次 connect 自动唤醒/,
    'the tool selection guide must carry the shutdown row',
  );

  // round-2 seat-A F1：修正后的 workspace_id 描述钉（共享 part 的 "Required
  // … HW_WORKSPACE_ID" 措辞对本工具双半皆错——workspace_id 是可选的第三定位
  // 面，回退会静默绿，故钉 dev 口径文本）。
  const schemas = readFileSync(join(pluginRoot, 'src', 'packs', 'sandbox', 'schemas.ts'), 'utf8');
  assert.match(
    schemas,
    /workspace_id: z\s*\n?\s*\.string\(\)\s*\n?\s*\.optional\(\)\s*\n?\s*\.describe\('Workspace ID; defaults to the current workspace \(an alternative to session_id\/dev_stage_id\)'\)/,
    "the shutdown schema's workspace_id must carry the dev-caliber description, not the shared part's Required wording",
  );

  // frontmatter 触发面：lifecycle 覆盖列表加入 shutdown。
  assert.match(
    skill,
    /Covers sandbox lifecycle \(check-user, sign-agreement, connect, shutdown, release\)/,
    'the frontmatter description must name shutdown in the lifecycle coverage',
  );

  // 审批门第九个成员：标题、Gated 名单与确认语义句都点名 shutdown。
  assert.match(skill, /## Approval gate \(the nine mutating tools\)/, 'the gate heading must count nine');
  assert.match(
    skill,
    /Gated: `connect`, `exec_with_session`, `exec_one_shot`, `expose_tunnel`, `renew_tunnel`, `keepalive_watchdog`, `sign_agreement`, `credentials`, `shutdown`\./,
    'the gated list must name shutdown',
  );
  assert.match(
    skill,
    /connect \/ shutdown \/ the tunnel faces \/ sign_agreement \/ credentials confirm on every call/,
    'the always-flavor sentence must name shutdown',
  );

  // resource-pool 引用：核时提醒 bullet 与 shutdown 客户端行为（dev 逐字）。
  assert.match(
    resourcePool,
    /- persistent 生命周期提示追加核时提醒：\*\*如暂时不需要使用，建议尽快关机，避免持续消耗核时；可以告诉我帮你关机（实例与数据盘保留，下次连接会自动唤醒）。\*\* ephemeral 不出现该提示/,
    'the reference must pin the persistent core-hours reminder',
  );
  assert.match(
    resourcePool,
    /- `sandbox_shutdown` 调 hdkitservice `POST \/shutdown`（DevStation `close`，不 delete）；仅开发者明确要求时调用；返回 `stopped` \/ `shutting_down` \/ `already_stopped` \/ `close_requested`。非持久化沙箱也可关机，但不主动提示/,
    'the reference must pin the shutdown client behavior and the status vocabulary',
  );

  // 名册派生面：safety skill 的审批参考必须随 roster leaf 登记 shutdown
  // （structure.test.ts 的 roster 循环钉强制此行——漏行即结构守卫红）。
  assert.ok(
    approvals.includes('- `huaweicloud_sandbox_shutdown`'),
    'the safety approvals reference must list shutdown per the roster leaf',
  );
  assert.match(
    approvals,
    /connect, shutdown, the tunnel faces, sign_agreement, credentials, and the hcloud run face's write-classified commands/,
    'the approvals always-flavor sentence must name shutdown',
  );
});
