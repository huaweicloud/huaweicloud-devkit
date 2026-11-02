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
  // Mapping-bearing pins (the #1021 doctrine: pin the routing semantics with
  // regexes that carry the mapping, not keyword presence — a pool-type flip
  // in any row must red the gate).
  assert.match(
    poolSection,
    /\|\s*预览 \/ 试用 \/ demo\s+\| 非持久化\s+\|/,
    'preview/trial/demo must route to the ephemeral pool',
  );
  assert.match(
    poolSection,
    /\|\s*一次性任务（跑完即弃）\s+\| 非持久化\s+\|/,
    'one-shot tasks must route to the ephemeral pool',
  );
  assert.match(
    poolSection,
    /\|\s*敏感内容（即焚）\s+\| 非持久化\s+\|/,
    'sensitive burn-after content must route to the ephemeral pool',
  );
  assert.match(
    poolSection,
    /\|\s*开发工作台 \/ workbench\s+\| 持久化\s+\|/,
    'workbench must route to the persistent pool',
  );
  assert.match(
    poolSection,
    /\|\s*带数据库项目（DB-backed）\s+\| 持久化\s+\|/,
    'DB-backed projects must route to the persistent pool',
  );
  assert.match(
    poolSection,
    /\|\s*跨日评审 \/ 展示\s+\| 持久化\s+\|/,
    'multi-day review must route to the persistent pool',
  );
  // The selection-rules bullet carries the same mapping inline — its example
  // must not invert against the table.
  assert.match(
    poolSection,
    /preview\/即焚 request → 非持久化; a workbench\/数据库 request → 持久化\)/,
    'the auto-select example must carry the correct intent-to-pool mappings',
  );
  // The 429 error-class-to-remediation mapping: the full sentence is pinned
  // (a clause swap between the classes is the same defect class as a
  // routing-row flip).
  // The selection-rules bullet leads carry the type attributions; their
  // doctrine tails carry the never-promise and survive-reboots rules. Both
  // must not invert against the table.
  assert.match(
    poolSection,
    /\*\*非持久化 sandboxes are fixed 3h\*\* — never promise durability/,
    'the fixed-3h bullet must attribute the 3h window to the ephemeral type with the never-promise rule',
  );
  assert.match(
    poolSection,
    /\*\*持久化 sandboxes mount an EVS disk \(32G\)\*\* — project code and databases survive reboots; treat them as the default for anything that must outlive the session \(see also/,
    'the EVS bullet must attribute the mount to the persistent type with the survive-reboots and default-for-durability rules',
  );
  assert.match(
    poolSection,
    /the same type is \*\*reused\*\* \(one user one instance per pool — `huaweicloud_sandbox_connect` reuses an existing instance of that type instead of creating a second\)\./,
    'the same-type reuse rule must be stated with its connect semantics (dev pin)',
  );
  assert.match(
    poolSection,
    /Broadcast this when starting a billable-length session/,
    'the core-hour burn broadcast trigger must be stated',
  );
  assert.match(poolSection, /\*\*Agent auto-selects by intent\*\*/, 'the agent must auto-select by intent');
  assert.match(
    poolSection,
    /the agent auto-selects from the request, and the developer may override:/,
    'the section intro must keep the auto-select/override restatement',
  );
  assert.match(poolSection, /The developer can always override/, 'the developer override rule must hold');
  assert.match(
    poolSection,
    /Quota is \*\*1 instance per type\*\*:/,
    'the per-type quota rule must be stated at its sentence lead',
  );
  assert.match(
    poolSection,
    /a developer may hold 1 非持久化 AND 1 持久化 simultaneously/,
    'holding both types simultaneously must be stated',
  );
  assert.match(
    poolSection,
    /Exceeding quota returns \*\*HTTP 429 with a Retry-After header\*\* plus a distinct error code — distinguish \*\*quota exceeded\*\* \(429; wait per Retry-After, or free the slot by finishing the other task\) from \*\*capacity insufficient\*\* \(pool full; retry later or pick the other type\)\./,
    'the skill bullet must state the full 429 arrival and class-to-remedy sentence',
  );
  assert.match(
    poolSection,
    /distinguish \*\*quota exceeded\*\* \(429; wait per Retry-After, or free the slot by finishing the other task\) from \*\*capacity insufficient\*\* \(pool full; retry later or pick the other type\)/,
    'the skill bullet must state the full class-to-remedy mapping',
  );
  assert.match(
    poolSection,
    /when a sandbox consumes core-hours \(烧核\), report the burn to the developer using the gifting wording — 核时来自「平台赠送 \+ 活动赚取」口径，非直接计费。/,
    'the burn-report duty sentence must carry its gifting compound through the sentence end',
  );
  assert.match(
    poolSection,
    /Full parameter table: \[references\/resource-pool\.md\]\(references\/resource-pool\.md\)/,
    'the quota bullet must link the parameter table in context',
  );
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
  // Column attribution for every doctrine-bearing lifecycle row: the pin
  // anchors the phrase to its cell ([^|] cannot cross a cell boundary), so a
  // cell swap or a header swap reds the gate while a semantics-preserving
  // reword of neighboring prose stays green.
  assert.match(
    lifecycleSection,
    /\| Phase\s+\| 持久化 \(persistent\)\s+\| 非持久化 \(ephemeral\)/,
    'the lifecycle table columns must stay persistent-then-ephemeral',
  );
  assert.match(
    lifecycleSection,
    /\| Idle shutdown\s+\|\s*\*\*1h idle → shutdown\*\* \(relaxed from the platform's 10min\)\s*\|\s*n\/a/,
    'the 1h idle rule with its relaxation note must sit contiguous in the persistent column with n/a on the ephemeral side',
  );
  assert.match(
    lifecycleSection,
    /\| Activity signals\s+\|\s*\*\*Three signals\*\* count as active: terminal connect \/ running processes \/ preview traffic \(tunnel\)\. Any signal within the idle window resets the 1h timer\s*\|\s*n\/a/,
    'the three activity signals and the 1h-timer reset rule must sit in the persistent column with n/a on the ephemeral side',
  );
  assert.match(
    lifecycleSection,
    /\| Pre-shutdown\s+\|\s*Platform notifies the developer \*\*before\*\*[^|]*— surface this reminder, never fight it\s*\|\s*n\/a/,
    'the pre-shutdown notification reminder must sit in the persistent column with n/a on the ephemeral side (dev pin)',
  );
  assert.match(
    lifecycleSection,
    /\| Hard expiry\s+\|\s*none[^|]*\|\s*\*\*Fixed 3h from CreateTime\*\* \(CreateTime 判定，不可续\)\s*\|/,
    'the 3h hard expiry must sit in the ephemeral column with no hard expiry on the persistent side',
  );
  assert.match(
    lifecycleSection,
    /\| Retention\s+\|\s*\*\*14 days after stop\*\* \(业务定稿\) — then reclaimed by the resource-group idle-deletion policy\s*\|\s*Reclaimed with the instance/,
    'the 14-day retention with its reclaim path must sit in the persistent column with reclaim on the ephemeral side',
  );
  assert.match(
    lifecycleSection,
    /\| Deletion\s+\|\s*① developer-initiated delete \(devkit asks for a \*\*second confirmation\*\* before user-side delete\) ② resource-group policy reclaim after the 14-day retention\. \*\*No deletion API is exposed to devkit\*\*, and \*\*devkit never defers\/delays deletion on the developer's behalf\*\*\s*\|\s*Same policy semantics/,
    'the Deletion row must keep its full doctrine cell — developer-initiated double-confirm, 14-day policy reclaim, no deletion API, never-defers — with same-policy ephemeral semantics',
  );
  // Absence pins (the paired-cell doctrine-leak class): the doctrine must
  // not ALSO appear in the other column — duplication and single-cell
  // overwrites of the non-anchor cell red the gate without freezing the
  // absence-side wording.
  assert.doesNotMatch(
    lifecycleSection,
    /\| Idle shutdown\s+\|[^|]*\|[^|]*1h idle/,
    'the 1h idle doctrine must not leak into the ephemeral column',
  );
  assert.doesNotMatch(
    lifecycleSection,
    /\| Activity signals\s+\|[^|]*\|[^|]*Three signals/,
    'the three-signal doctrine must not leak into the ephemeral column',
  );
  assert.doesNotMatch(
    lifecycleSection,
    /\| Pre-shutdown\s+\|[^|]*\|[^|]*notifies the developer/,
    'the pre-shutdown doctrine must not leak into the ephemeral column',
  );
  assert.doesNotMatch(
    lifecycleSection,
    /\| Hard expiry\s+\|[^|]*3h/,
    'the 3h hard expiry must not leak into the persistent column',
  );
  assert.doesNotMatch(
    lifecycleSection,
    /\| Retention\s+\|[^|]*\|[^|]*14 days/,
    'the 14-day retention must not leak into the ephemeral column',
  );
  assert.doesNotMatch(
    lifecycleSection,
    /\| Deletion\s+\|[^|]*\|[^|]*second confirmation/,
    'the deletion double-confirm must not leak into the ephemeral column',
  );
  assert.match(lifecycleSection, /不做延后代删/, 'the no-deferred-deletion rule must be stated');
  assert.match(
    lifecycleSection,
    /Never schedule delayed\/deferred deletion on the developer's behalf \(不做延后代删\)\./,
    'the no-deferred-deletion rule must be stated in English too',
  );
  assert.match(
    lifecycleSection,
    /devkit does NOT expose a lifecycle deletion API for resource-pool instances — cleanup is the platform resource-group idle-deletion policy \(G1\)\./,
    'the hard-rules bullet must state the no-API rule with the platform cleanup path',
  );
  assert.match(
    lifecycleSection,
    /On a developer-initiated delete, always ask for \*\*explicit second confirmation\*\* \(确认要删除？数据不可恢复\) before proceeding\./,
    'the hard-rules bullet must demand the double-confirm with the always',
  );
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(lifecycleSection, new RegExp(`\\*\\*${g}\\*\\*`), `platform dependency ${g} must be listed`);
  }
  // G1 is the one load-bearing G mapping (it drives the 14-day reclaim the
  // deletion doctrine cites); G2-G5 stay presence-pinned (awareness-only
  // content, recorded headroom). Both G-list surfaces state it.
  assert.match(
    lifecycleSection,
    /G1\*\* — 资源组闲置删除策略配置 \(idle-deletion policy for the resource group, drives the 14-day reclaim\)/,
    'the skill G1 mapping must be pinned in full',
  );
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
  assert.match(
    skill,
    /1 instance per type, same type reuses/,
    'Step 0.3 must state the per-type quota and same-type reuse',
  );
  assert.match(
    skill,
    /auto by intent, developer may override;/,
    'Step 0.3 must keep the auto-select-with-override clause',
  );
  assert.match(
    skill,
    /same type reuses\)\. Check the task survives the chosen type's lifecycle window \(\[Sandbox Lifecycle & Retention\]/,
    'Step 0.3 must keep the lifecycle survival check at its sentence lead',
  );
});

test('resource-pool reference documents the pool capacity parameters and is linked (#1071)', () => {
  const resourcePool = readFileSync(referencePath, 'utf8');
  // Mapping-bearing pins: the 申请 capacity rows and the 两类沙箱 type table
  // carry the pool-type attributions — presence pins would survive a swap.
  // Attribution pins use within-cell wildcards ([^|] cannot cross a cell
  // boundary), so a semantics-preserving reword stays green.
  assert.match(
    resourcePool,
    /\| 持久化 2U4G 规格\s+\| 300 实例\s*\|/,
    'persistent 2U4G must be documented at 300 instances',
  );
  assert.match(
    resourcePool,
    /\| 持久化 4U8G 规格\s+\| 200 实例\s*\|/,
    'persistent 4U8G must be documented at 200 instances',
  );
  assert.match(
    resourcePool,
    /\| 非持久化 2U4G 规格\s+\| 1000 实例\s*\|/,
    'ephemeral 2U4G must be documented at 1000 instances',
  );
  assert.match(
    resourcePool,
    /\| 维度\s+\| 非持久化 \(ephemeral\)\s+\| 持久化 \(persistent\)/,
    'the type table columns must stay ephemeral-then-persistent',
  );
  assert.match(
    resourcePool,
    /\| 定位\s+\|\s*预览\/试用\/一次性任务\/敏感即焚\s+\|\s*开发工作台\/带数据库项目\/跨日评审展示\s*\|/,
    'the 定位 row must keep the full intent-to-type mapping on both sides',
  );
  assert.match(
    resourcePool,
    /\| 生命周期\s+\|\s*固定 3h（CreateTime 判定）\s+\|\s*1h 闲置关机[\s+与、]*三信号活性\s*\|/,
    'the type table must keep 3h-with-ephemeral (CreateTime) and 1h-idle-with-three-signal-activity on the persistent side',
  );
  assert.match(
    resourcePool,
    /\| 存储\s+\|\s*无持久盘\s+\|\s*挂 EVS 32G\s*\|/,
    'the type table must keep the EVS mount on the persistent side',
  );
  // Absence pins (the paired-cell doctrine-leak class, mirroring the skill's
  // lifecycle table): the doctrine must not also appear in the other column.
  assert.doesNotMatch(
    resourcePool,
    /\| 生命周期\s+\|[^|]*1h 闲置/,
    'the 1h-idle doctrine must not leak into the ephemeral column',
  );
  assert.doesNotMatch(resourcePool, /\| 存储\s+\|[^|]*EVS/, 'the EVS doctrine must not leak into the ephemeral column');
  assert.doesNotMatch(
    resourcePool,
    /\| 定位\s+\|[^|]*工作台/,
    'the workbench doctrine must not leak into the ephemeral column',
  );
  assert.match(
    resourcePool,
    /\| overlayer\s+\| 5 GB \/ 实例\s*\|/,
    'the overlayer row must carry the 5 GB per-instance quota',
  );
  assert.match(resourcePool, /\| EVS（持久化挂盘）\s+\| 300 TB 总量\s*\|/, 'the EVS row must carry the 300 TB total');
  // The 配额与超限语义 section is the reference's own statement of the quota
  // model and the 429 class-to-remedy mapping — the third 429-bearing
  // surface, so its bullets carry mapping pins like the skill bullet and the
  // connect description.
  assert.match(
    resourcePool,
    /每用户每类型 1 个实例；可同时持有 1 非持久化 \+ 1 持久化；同类请求复用现有实例。/,
    'the reference quota bullet must restate the per-type/dual-holding/reuse model',
  );
  assert.match(
    resourcePool,
    /超限响应：\*\*HTTP 429 \+ `Retry-After` 头 \+ 错误码\*\*/,
    'the reference must state the full 429 response compound',
  );
  assert.match(
    resourcePool,
    /错误码必须区分两类失败/,
    'the reference must name the error code as the class discriminator',
  );
  assert.match(
    resourcePool,
    /配额超限（quota exceeded）\*\* — 用户侧持有已达上限；按 `Retry-After` 等待或结束占用该类型沙箱的任务后再试。/,
    'the reference must map quota-exceeded to the full wait-or-free remedy',
  );
  assert.match(
    resourcePool,
    /容量不足（capacity insufficient）\*\* — 资源池侧无可用容量；稍后重试或改选另一类型。/,
    'the reference must map capacity-insufficient to the full retry-or-other-type remedy',
  );
  assert.match(
    resourcePool,
    /核时来源于\*\*平台赠送 \+ 活动赚取\*\*（非直接计费口径）/,
    'the burn-hour gifting wording must be stated',
  );
  assert.match(resourcePool, /429/, 'the 429 contract must be documented');
  assert.match(resourcePool, /Retry-After/, 'the Retry-After header must be documented');
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    assert.match(resourcePool, new RegExp(`${g} `), `platform dependency ${g} must be mirrored`);
  }
  // G1's mapping on the reference surface, in full (mirroring the skill pin).
  assert.match(
    resourcePool,
    /- G1 闲置删除策略配置（资源组，驱动 14 天保留期回收）/,
    'the reference G1 mapping must be pinned in full',
  );

  const skill = readFileSync(skillPath, 'utf8');
  assert.match(
    skill,
    /- \[Resource Pool\]\(references\/resource-pool\.md\) — 资源池定稿口径/,
    'the References list must link the resource-pool reference',
  );
  assert.match(
    skill,
    /持久 2U4G×300 \+ 4U8G×200、非持久 2U4G×1000/,
    'the References link line must carry the capacity mapping it advertises',
  );
  // The late-flow catch-all surface: the warnings table carries the pool row
  // beside the two gate rows (the #1021 v2-wins precedent — the table is the
  // surface an agent consults last).
  assert.match(skill, /Pool type fixes durability/, 'the Critical Warnings table must carry the pool-type row');
  // The v2-authored row is the one surface with no dev source of truth, so
  // its full doctrine body is pinned: the 429 discriminator (the error code,
  // not the HTTP status, separates the two failure classes — the
  // dev-verbatim surfaces teach both classes arrive as 429), the routing
  // tails, the lifecycle facts, the gate sentence, and the class-to-remedy
  // mapping. The pin is the row's source of truth.
  const warningsRow = skill.split('\n').find((line) => line.includes('Pool type fixes durability')) ?? '';
  assert.match(
    warningsRow,
    /A rejected connect returns HTTP 429 with a Retry-After header and an error code/,
    'the warnings row must state the full 429 arrival contract',
  );
  assert.match(
    warningsRow,
    /the CODE, not the status, separates the two failure classes/,
    'the warnings row must discriminate the 429 classes by error code, not status',
  );
  assert.match(
    warningsRow,
    /预览\/试用\/即焚 requests belong on the 非持久化 pool — a FIXED 3h window from CreateTime, 不可续, nothing survives it/,
    'the warnings row must route ephemeral intents to the 3h pool',
  );
  assert.match(
    warningsRow,
    /工作台\/带数据库\/跨日 requests belong on the 持久化 pool \(EVS 32G mounted, survives reboots, 14-day retention after stop\)/,
    'the warnings row must route workbench intents to the EVS pool',
  );
  assert.match(
    warningsRow,
    /Pick per the Resource Pool Selection table \(Step 0\.3\) BEFORE calling `sandbox_connect`, and never promise durability on an ephemeral sandbox\./,
    'the warnings row must carry the Step 0.3 gate sentence',
  );
  assert.match(
    warningsRow,
    /quota exceeded \(1 instance per type — wait per Retry-After or free the slot\) vs capacity insufficient \(pool full; retry later or pick the other type\)\./,
    'the warnings row must map each 429 class to its own remedy',
  );
  // v2-wins sync: the skill's own tool-summary table states the per-pool-type
  // quota model (dev's copy still teaches the superseded flat model — the
  // port changed the doctrine, so the in-file summary follows).
  assert.match(
    skill,
    /Connect to sandbox \(one user one instance per pool type, reuses existing of that type\)\s*\|/,
    'the tool table must state the per-pool-type quota model',
  );
  assert.doesNotMatch(
    skill,
    /Connect to sandbox \(one user one instance, reuses existing if available\)/,
    'the superseded flat quota model must not survive in the tool table',
  );
});

test('sandbox tool descriptions carry the quota/429 and no-delete semantics (#1071)', () => {
  const tools = readFileSync(toolsPath, 'utf8');

  const connectDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_connect');
  assert.match(
    connectDesc,
    /One user one instance per pool type - reuses an existing sandbox of that type if available, otherwise creates a new one\./,
    'connect must state the full per-pool-type reuse sentence',
  );
  assert.match(
    connectDesc,
    /reuses an existing sandbox of that type if available, otherwise creates a new one/,
    'connect must state per-pool-type reuse',
  );
  assert.match(connectDesc, /Quota: 1 instance per type \(/, 'connect must state the per-type quota');
  assert.match(
    connectDesc,
    /a user may hold 1 ephemeral AND 1 persistent sandbox simultaneously; same-type requests reuse the existing instance\)\./,
    'the connect quota parenthetical must keep the dual-holding and same-type-reuse mapping',
  );
  assert.match(
    connectDesc,
    /On quota exhaustion the API returns HTTP 429 with a Retry-After header and an error code that distinguishes quota-exceeded \(wait per Retry-After or free the slot\) from capacity-insufficient \(pool full; retry later or pick the other type\)\./,
    'connect must state the full 429 arrival and class-to-remedy contract',
  );
  assert.match(
    connectDesc,
    /an error code that distinguishes/,
    'the connect description must state the error code as the 429 discriminator',
  );
  // Mapping-bearing pins on the description's own routing sentence — the
  // connect description is the surface an agent sees without loading the
  // skill, so its intent-to-pool mapping AND its lifecycle attribution must
  // not silently contradict the skill's pinned table (a parenthetical swap
  // between the two types must red the gate).
  assert.match(
    connectDesc,
    /ephemeral = preview\/trial\/one-shot\/sensitive \(fixed 3h from CreateTime\)/,
    'the connect description must attribute the 3h expiry to the ephemeral type',
  );
  assert.match(
    connectDesc,
    /persistent = workbench\/DB-backed\/multi-day review \(EVS 32G mounted, 1h idle shutdown with connect\/process\/preview-traffic activity signals, 14-day retention\)/,
    'the connect description must attribute the EVS mount, idle shutdown, and retention to the persistent type',
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
    /Resource-pool sandbox deletion is developer-initiated \(always ask for a second confirmation before guiding a delete\) or handled by the platform resource-group idle-deletion policy after the 14-day retention; devkit never defers or performs deletion on the user behalf\./,
    'close_session must state the full deletion-attribution and never-defers sentence',
  );
});
