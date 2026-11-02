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
    /预览 \/ 试用 \/ demo\s+\| 非持久化\s+\|/,
    'preview/trial/demo must route to the ephemeral pool',
  );
  assert.match(
    poolSection,
    /一次性任务（跑完即弃）\s+\| 非持久化\s+\|/,
    'one-shot tasks must route to the ephemeral pool',
  );
  assert.match(
    poolSection,
    /敏感内容（即焚）\s+\| 非持久化\s+\|/,
    'sensitive burn-after content must route to the ephemeral pool',
  );
  assert.match(poolSection, /开发工作台 \/ workbench\s+\| 持久化\s+\|/, 'workbench must route to the persistent pool');
  assert.match(
    poolSection,
    /带数据库项目（DB-backed）\s+\| 持久化\s+\|/,
    'DB-backed projects must route to the persistent pool',
  );
  assert.match(poolSection, /跨日评审 \/ 展示\s+\| 持久化\s+\|/, 'multi-day review must route to the persistent pool');
  // The selection-rules bullet carries the same mapping inline — its example
  // must not invert against the table.
  assert.match(
    poolSection,
    /preview\/即焚 request → 非持久化; a workbench\/数据库 request → 持久化/,
    'the auto-select example must carry the correct intent-to-pool mappings',
  );
  // The 429 error-class-to-remediation mapping: each class keeps its own
  // remedy (a clause swap between the classes is the same defect class as a
  // routing-row flip).
  assert.match(
    poolSection,
    /quota exceeded\*\* \(429; wait per Retry-After/,
    'quota-exceeded must carry the 429 wait-or-free remedy',
  );
  assert.match(
    poolSection,
    /capacity insufficient\*\* \(pool full/,
    'capacity-insufficient must carry the pool-full retry remedy',
  );
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
    /\*\*持久化 sandboxes mount an EVS disk \(32G\)\*\* — project code and databases survive reboots/,
    'the EVS bullet must attribute the mount to the persistent type with the survive-reboots rule',
  );
  assert.match(poolSection, /the same type is \*\*reused\*\*/, 'the same-type reuse rule must be stated (dev pin)');
  assert.match(
    poolSection,
    /Broadcast this when starting a billable-length session/,
    'the core-hour burn broadcast trigger must be stated',
  );
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
    /\| Idle shutdown\s+\|[^|]*1h idle → shutdown/,
    'the 1h idle rule must sit in the persistent column',
  );
  assert.match(
    lifecycleSection,
    /\| Activity signals\s+\|[^|]*Three signals[^|]*terminal connect \/ running processes \/ preview traffic/,
    'the three activity signals must sit in the persistent column',
  );
  assert.match(
    lifecycleSection,
    /\| Pre-shutdown\s+\|[^|]*notifies the developer \*\*before\*\*[^|]*surface this reminder, never fight it/,
    'the pre-shutdown notification reminder must sit in the persistent column (dev pin)',
  );
  assert.match(
    lifecycleSection,
    /\| Hard expiry\s+\|[^|]*\|[^|]*Fixed 3h from CreateTime/,
    'the 3h hard expiry must sit in the ephemeral column',
  );
  assert.match(
    lifecycleSection,
    /\| Retention\s+\|[^|]*14 days after stop/,
    'the 14-day retention must sit in the persistent column',
  );
  assert.match(
    lifecycleSection,
    /\| Deletion\s+\|[^|]*second confirmation/,
    'the deletion double-confirm must sit in the persistent column',
  );
  assert.match(lifecycleSection, /relaxed from the platform's 10min/, 'the 10min relaxation note must be stated');
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
  assert.match(
    skill,
    /1 instance per type, same type reuses/,
    'Step 0.3 must state the per-type quota and same-type reuse',
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
    /\| 持久化 2U4G 规格\s+\| 300 实例/,
    'persistent 2U4G must be documented at 300 instances',
  );
  assert.match(
    resourcePool,
    /\| 持久化 4U8G 规格\s+\| 200 实例/,
    'persistent 4U8G must be documented at 200 instances',
  );
  assert.match(
    resourcePool,
    /\| 非持久化 2U4G 规格\s+\| 1000 实例/,
    'ephemeral 2U4G must be documented at 1000 instances',
  );
  assert.match(
    resourcePool,
    /\| 维度\s+\| 非持久化 \(ephemeral\)\s+\| 持久化 \(persistent\)/,
    'the type table columns must stay ephemeral-then-persistent',
  );
  assert.match(
    resourcePool,
    /\| 定位\s+\|[^|]*预览[^|]*\|[^|]*工作台/,
    'the 定位 row must keep the intent-to-type mapping',
  );
  assert.match(
    resourcePool,
    /\| 生命周期\s+\|[^|]*固定 3h[^|]*\|[^|]*1h 闲置关机/,
    'the type table must keep 3h-with-ephemeral and 1h-idle-with-persistent',
  );
  assert.match(
    resourcePool,
    /\| 存储\s+\|[^|]*无持久盘[^|]*\|[^|]*EVS 32G/,
    'the type table must keep the EVS mount on the persistent side',
  );
  assert.match(
    resourcePool,
    /\| overlayer\s+\| 5 GB \/ 实例/,
    'the overlayer row must carry the 5 GB per-instance quota',
  );
  assert.match(resourcePool, /\| EVS（持久化挂盘）\s+\| 300 TB/, 'the EVS row must carry the 300 TB total');
  // The 配额与超限语义 section is the reference's own statement of the 429
  // class-to-remedy mapping — the third 429-bearing surface, so its bullets
  // carry mapping pins like the skill bullet and the connect description.
  assert.match(
    resourcePool,
    /配额超限（quota exceeded）\*\* — 用户侧持有已达上限；按 `Retry-After` 等待/,
    'the reference must map quota-exceeded to the wait-or-free remedy',
  );
  assert.match(
    resourcePool,
    /容量不足（capacity insufficient）\*\* — 资源池侧无可用容量；稍后重试或改选另一类型/,
    'the reference must map capacity-insufficient to the retry-or-other-type remedy',
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
    /the CODE, not the status, separates the two failure classes/,
    'the warnings row must discriminate the 429 classes by error code, not status',
  );
  assert.match(
    warningsRow,
    /预览\/试用\/即焚 requests belong on the 非持久化 pool — a FIXED 3h window from CreateTime, 不可续/,
    'the warnings row must route ephemeral intents to the 3h pool',
  );
  assert.match(
    warningsRow,
    /工作台\/带数据库\/跨日 requests belong on the 持久化 pool \(EVS 32G mounted, survives reboots, 14-day retention after stop\)/,
    'the warnings row must route workbench intents to the EVS pool',
  );
  assert.match(
    warningsRow,
    /Pick per the Resource Pool Selection table \(Step 0\.3\) BEFORE calling `sandbox_connect`, and never promise durability on an ephemeral sandbox/,
    'the warnings row must carry the Step 0.3 gate sentence',
  );
  assert.match(
    warningsRow,
    /quota exceeded \(1 instance per type — wait per Retry-After or free the slot\) vs capacity insufficient \(pool full; retry later or pick the other type\)/,
    'the warnings row must map each 429 class to its own remedy',
  );
  // v2-wins sync: the skill's own tool-summary table states the per-pool-type
  // quota model (dev's copy still teaches the superseded flat model — the
  // port changed the doctrine, so the in-file summary follows).
  assert.match(
    skill,
    /Connect to sandbox \(one user one instance per pool type, reuses existing of that type\)/,
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
  assert.match(connectDesc, /One user one instance per pool type/, 'connect must state the per-pool-type quota model');
  assert.match(
    connectDesc,
    /reuses an existing sandbox of that type if available, otherwise creates a new one/,
    'connect must state per-pool-type reuse',
  );
  assert.match(connectDesc, /1 instance per type/, 'connect must state the per-type quota');
  assert.match(connectDesc, /1 ephemeral AND 1 persistent/, 'connect must state dual-type holding');
  assert.match(connectDesc, /HTTP 429 with a Retry-After header/, 'connect must state the 429 contract');
  assert.match(connectDesc, /quota-exceeded/, 'connect must name the quota-exceeded class');
  assert.match(connectDesc, /capacity-insufficient/, 'connect must name the capacity-insufficient class');
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
  assert.match(
    connectDesc,
    /quota-exceeded \(wait per Retry-After/,
    'quota-exceeded must carry the wait-or-free remedy',
  );
  assert.match(
    connectDesc,
    /capacity-insufficient \(pool full/,
    'capacity-insufficient must carry the pool-full remedy',
  );
  // v2 divergence: the vendor-gate seam stays on the connect description.
  assert.match(connectDesc, /Vendor-gated \(vendorConfirmed\)/, 'connect must keep the vendor-gate sentence');

  const closeDesc = toolDescriptionBlock(tools, 'huaweicloud_sandbox_close_session');
  assert.match(closeDesc, /does NOT delete the sandbox instance/, 'close_session must disclaim deletion');
  assert.match(
    closeDesc,
    /always ask for a second confirmation/,
    'close_session must demand the deletion double-confirm (the always is load-bearing)',
  );
  assert.match(closeDesc, /14-day retention/, 'close_session must state the retention window');
  assert.match(closeDesc, /idle-deletion policy/, 'close_session must name the platform reclaim path');
  assert.match(
    closeDesc,
    /devkit never defers or performs deletion on the user behalf/,
    'close_session must carry the never-defers clause',
  );
});
