import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');
const skill = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
const resourcePool = readFileSync(
  join(pluginRoot, 'skills', 'huawei-sandbox', 'references', 'resource-pool.md'),
  'utf8',
);

test('sandbox pool selection: default ephemeral and preview stays ephemeral for full-stack/DB', () => {
  assert.match(skill, /## Pool-Selection Gate/);
  assert.match(skill, /Default is `ephemeral`/);
  assert.match(skill, /Preview \/ demo \/ trial \/ one-off \/ sensitive burn-after-use → `ephemeral`/);
  assert.match(skill, /even for full-stack or DB-backed projects/);
  assert.match(skill, /does not by itself require persistence/);
  assert.match(resourcePool, /## 选型决策树/);
  assert.ok(resourcePool.includes('全栈/DB 但只是预览/演示'));
  assert.ok(resourcePool.includes('不因技术栈升级'));
});

test('sandbox pool selection: persistent requires explicit long-term intent or confirmation', () => {
  assert.match(skill, /Use `persistent` only when:/);
  assert.ok(
    skill.includes(
      'the developer explicitly says long-term / cross-day / resume later / keep data / development workbench',
    ),
  );
  assert.match(skill, /ask once before connecting/);
  assert.ok(skill.includes('Never select `persistent` merely because the project is full-stack or DB-backed.'));
  assert.ok(resourcePool.includes('不得仅因 full-stack/DB 选 persistent'));
});

test('sandbox pool selection: task continuity and new-preview reuse confirmation', () => {
  assert.ok(skill.includes('这个任务需要跨会话保留数据吗'));
  assert.ok(skill.includes('Same task / same deployment follow-up: keep the current pool'));
  assert.ok(
    skill.includes(
      'New task: re-evaluate. A new preview stays `ephemeral` even if a persistent sandbox already exists.',
    ),
  );
  assert.ok(skill.includes('已有持久化沙箱，是否直接复用（保留现有环境/数据），还是新建临时预览环境？'));
  assert.ok(skill.includes('Switching pools does not migrate data'));
  assert.ok(resourcePool.includes('数据不跨池迁移'));
});

test('sandbox pool selection: stack gate runs before pool gate', () => {
  const stackIdx = skill.indexOf('Step 0.5 — Stack-Selection Gate');
  const poolIdx = skill.indexOf('Step 0.6 — Pool-Selection Gate');
  assert.ok(stackIdx > -1, 'Stack-Selection Gate step must exist');
  assert.ok(poolIdx > -1, 'Pool-Selection Gate step must exist');
  assert.ok(stackIdx < poolIdx, 'Stack gate must be resolved before pool selection');
  assert.equal(skill.includes('Step 0.3 — Resource pool selection'), false);
});

test('sandbox pool selection: old DB-implies-persistent rows are gone', () => {
  assert.equal(skill.includes('带数据库项目（DB-backed）'), false);
  assert.equal(resourcePool.includes('开发工作台/带数据库项目/跨日评审展示'), false);
  assert.ok(skill.includes('带数据库且需要跨会话保留数据'));
});
