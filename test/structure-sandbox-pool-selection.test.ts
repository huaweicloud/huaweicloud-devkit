import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot } from './structure-helpers.ts';

const readSkill = (): string =>
  readFileSync(join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
const readResourcePool = (): string =>
  readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'resource-pool.md'),
    'utf8',
  );

// The port of dev b1ab4029's test/sandbox-pool-selection.test.mjs (PR-5 of the
// dev→v2 ladder): the pool choice is gated on TASK INTENT, never on tech
// stack. The gate doctrine must be readable where the agent reads it — the
// skill's gate section and the resource-pool reference's decision tree — and
// the superseded DB-implies-persistent routing must not survive on either
// surface.

test('sandbox pool selection: default ephemeral and preview stays ephemeral for full-stack/DB', () => {
  const skill = readSkill();
  assert.match(skill, /## Pool-Selection Gate/);
  assert.match(skill, /Default is `ephemeral`/);
  assert.match(skill, /Preview \/ demo \/ trial \/ one-off \/ sensitive burn-after-use → `ephemeral`/);
  assert.match(skill, /even for full-stack or DB-backed projects/);
  assert.match(skill, /does not by itself require persistence/);
  const resourcePool = readResourcePool();
  assert.match(resourcePool, /## 选型决策树/);
  assert.ok(resourcePool.includes('全栈/DB 但只是预览/演示'), 'decision tree must route DB previews to ephemeral');
  assert.ok(resourcePool.includes('不因技术栈升级'), 'decision tree must forbid stack-triggered upgrades');
});

test('sandbox pool selection: persistent requires explicit long-term intent or confirmation', () => {
  const skill = readSkill();
  assert.match(skill, /Use `persistent` only when:/);
  assert.ok(
    skill.includes(
      'the developer explicitly says long-term / cross-day / resume later / keep data / development workbench',
    ),
    'the persistent triggers must be enumerated in the gate',
  );
  assert.match(skill, /ask once before connecting/);
  assert.ok(
    skill.includes('Never select `persistent` merely because the project is full-stack or DB-backed.'),
    'the stack-is-not-a-trigger never-rule must be verbatim',
  );
  const resourcePool = readResourcePool();
  assert.ok(
    resourcePool.includes('不得仅因 full-stack/DB 选 persistent'),
    'the decision tree must state the no-stack-trigger rule',
  );
});

test('sandbox pool selection: task continuity and new-preview reuse confirmation', () => {
  const skill = readSkill();
  assert.ok(skill.includes('这个任务需要跨会话保留数据吗'), 'the ambiguity question must be taught verbatim');
  assert.ok(skill.includes('Same task / same deployment follow-up: keep the current pool'));
  assert.ok(
    skill.includes(
      'New task: re-evaluate. A new preview stays `ephemeral` even if a persistent sandbox already exists.',
    ),
  );
  assert.ok(
    skill.includes('已有持久化沙箱，是否直接复用（保留现有环境/数据），还是新建临时预览环境？'),
    'the reuse question must be taught verbatim',
  );
  assert.ok(skill.includes('Switching pools does not migrate data'));
  const resourcePool = readResourcePool();
  assert.ok(resourcePool.includes('数据不跨池迁移'), 'the decision tree must restate the no-migration rule');
});

test('sandbox pool selection: stack gate runs before pool gate', () => {
  const skill = readSkill();
  const stackIdx = skill.indexOf('**Step 0.5 — Stack-Selection Gate');
  const poolIdx = skill.indexOf('**Step 0.6 — Pool-Selection Gate');
  assert.ok(stackIdx > -1, 'Stack-Selection Gate step must exist');
  assert.ok(poolIdx > -1, 'Pool-Selection Gate step must exist');
  assert.ok(stackIdx < poolIdx, 'Stack gate must be resolved before pool selection');
  assert.equal(skill.includes('**Step 0.3 — Resource pool selection**'), false);
});

test('sandbox pool selection: old DB-implies-persistent rows are gone', () => {
  const skill = readSkill();
  assert.equal(skill.includes('带数据库项目（DB-backed）'), false);
  const resourcePool = readResourcePool();
  assert.equal(resourcePool.includes('开发工作台/带数据库项目/跨日评审展示'), false);
  assert.ok(skill.includes('带数据库且需要跨会话保留数据'));
});

test('sandbox pool selection: lifecycle numbers stay internal, the broadcast posture defers to TTL 播报', () => {
  // dev b1ab4029 carries the numbers-caliber sentence with an absolute
  // "ephemeral 不向开发者播报" and a persistent "不播报隧道有效期/自动续期"
  // — but on the dev line BOTH clauses landed in 57984a2a TOGETHER with the
  // rewrite of the TTL bullet, Step 10, and the expose delivery copy they
  // supersede. v2 still pins the pre-57984a2a postures (the TTL 播报 bullet
  // and the expose step's delivery copy 「链接已生成，默认自动续期保活」),
  // so the ported sentence keeps the internal-use scoping and the positive
  // announce scopes (persistent: sandbox lifecycle + core-hour reminders),
  // and defers both announce postures to the pinned surfaces instead of
  // contradicting them. Both dev clauses are absence-pinned below so the
  // broadcast-shift port re-adds them consciously WITH the companion flips.
  const skill = readSkill();
  assert.match(skill, /下表生命周期数值仅用于内部选池与诊断/);
  assert.match(skill, /persistent 只播报沙箱生命周期与核时提醒/);
  assert.match(
    skill,
    /ephemeral 数值只在下文 \*\*TTL 播报\*\* 的时机与口径内提示，其余场合不向开发者播报/,
    'the ephemeral announce posture must defer to the pinned TTL 播报 bullet, never contradict it',
  );
  assert.doesNotMatch(
    skill,
    /ephemeral 不向开发者播报/,
    'the dev 57984a2a absolute-silence clause must not land without its broadcast-shift rewrite',
  );
  assert.doesNotMatch(
    skill,
    /不播报隧道有效期/,
    'the dev tunnel-subject prohibition must not land while the pinned expose delivery copy names 自动续期保活 (57984a2a flipped that companion on dev; v2 has not ported the flip)',
  );
});
