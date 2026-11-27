import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DELETE_SCENARIOS,
  POST_DELETE_SCENARIOS,
  classifyPostDeleteQuery,
  planDeleteRetention,
} from './fixtures/issue-1182-delete-simulation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const skills = join(root, 'plugins', 'huaweicloud-core', 'skills');
const read = (...parts) => readFileSync(join(skills, ...parts), 'utf8');

const ecsSkill = read('huawei-ecs', 'SKILL.md');
const deleteReference = read('huawei-ecs', 'references', 'delete-instance.md');
const createReference = read('huawei-ecs', 'references', 'create-instance.md');
const ecsTroubleshooting = read('huawei-ecs', 'references', 'troubleshooting.md');
const evsReference = read('huawei-ecs', 'references', 'evs.md');
const iacSkill = read('huawei-iac', 'SKILL.md');
const resourceCatalog = read('huawei-iac', 'references', 'resource-catalog.md');

// ---------------------------------------------------------------------------
// Documentation guards (#1182 acceptance 1)
// ---------------------------------------------------------------------------

test('ECS skill no longer claims "both flags false" keeps EIP and system disk (#1182)', () => {
  assert.doesNotMatch(ecsSkill, /public IP and system disk survive deletion/i);
  assert.doesNotMatch(ecsSkill, /Data disks ARE deleted by default/i);
  assert.doesNotMatch(ecsSkill, /Delete instance[^\n]*--delete_publicip=true/);
  assert.match(ecsSkill, /references\/delete-instance\.md/);
  assert.match(ecsSkill, /omitted/i);
  assert.match(ecsSkill, /data disks only/i);
  assert.match(ecsSkill, /delete_on_termination/);
});

test('delete-instance reference distinguishes omit / explicit value / mount policy (#1182)', () => {
  assert.match(deleteReference, /omitted|omit the flag/i);
  assert.match(deleteReference, /delete_on_termination/);
  assert.match(deleteReference, /system disk/i);
  assert.match(deleteReference, /data disks only/i);
  assert.match(deleteReference, /detach it first/i);
  assert.match(deleteReference, /by resource ID/i);
  assert.match(deleteReference, /unverified/i);
  assert.match(deleteReference, /usage time/i);
});

test('create-instance §9 no longer says "default false, set true" (#1182)', () => {
  assert.doesNotMatch(createReference, /default to false\. Set to true/i);
  assert.doesNotMatch(createReference, /Delete instance \(with cleanup\)/);
  assert.match(createReference, /references\/delete-instance\.md/);
});

test('troubleshooting no longer claims data disks are deleted by default (#1182)', () => {
  assert.doesNotMatch(ecsTroubleshooting, /数据盘默认随实例删除/);
  assert.doesNotMatch(ecsTroubleshooting, /--delete_publicip=true --delete_volume=true/);
  assert.match(ecsTroubleshooting, /delete_on_termination/);
  assert.match(ecsTroubleshooting, /计费使用时间/);
});

test('EVS reference describes the delete_volume OR-semantics (#1182)', () => {
  assert.doesNotMatch(evsReference, /does NOT automatically delete attached EVS volumes unless/i);
  assert.match(evsReference, /delete_on_termination/);
  assert.match(evsReference, /detach it first/i);
});

test('IaC skill and resource catalog stop recommending both delete flags by default (#1182)', () => {
  assert.doesNotMatch(iacSkill, /ECS delete defaults leak resources/i);
  assert.match(iacSkill, /mount policy/i);
  assert.match(iacSkill, /delete_on_termination/);
  assert.doesNotMatch(resourceCatalog, /--delete_publicip=true --delete_volume=true/);
  assert.match(resourceCatalog, /references\/delete-instance\.md/);
});

// ---------------------------------------------------------------------------
// Simulated retention records (#1182 acceptance 2)
// ---------------------------------------------------------------------------

test('EIP omission vs explicit false follows delete_on_termination (#1182)', () => {
  const omittedTrue = planDeleteRetention({
    eip: { id: 'eip-a', deleteOnTermination: true },
    params: {},
  });
  assert.equal(omittedTrue.eip.state, 'deleted');

  const omittedFalse = planDeleteRetention({
    eip: { id: 'eip-b', deleteOnTermination: false },
    params: {},
  });
  assert.equal(omittedFalse.eip.state, 'kept');

  const explicitFalse = planDeleteRetention({
    eip: { id: 'eip-c', deleteOnTermination: true },
    params: { deletePublicip: false },
  });
  assert.equal(explicitFalse.eip.state, 'kept');
});

test('a data disk with delete_on_termination=true is deleted even when delete_volume=false (#1182)', () => {
  const plan = planDeleteRetention({
    eip: { id: 'eip-a', deleteOnTermination: false },
    dataDisks: [{ id: 'vol-protected', deleteOnTermination: true, intent: 'deleted' }],
    params: { deleteVolume: false },
  });
  assert.deepEqual(plan.dataDisks, [{ id: 'vol-protected', state: 'deleted' }]);
});

test('unknown policy and intent conflict force confirmation before submission (#1182)', () => {
  const unknown = planDeleteRetention({
    eip: { id: 'eip-a' },
    params: {},
  });
  assert.equal(unknown.eip.state, 'unknown');
  assert.equal(unknown.requiresConfirmation, true);

  const conflict = planDeleteRetention({
    eip: { id: 'eip-a', deleteOnTermination: false },
    dataDisks: [{ id: 'vol-protected', deleteOnTermination: true, intent: 'kept' }],
    params: { deleteVolume: false },
  });
  assert.equal(conflict.dataDisks[0].state, 'deleted');
  assert.deepEqual(conflict.conflicts, ['volume:vol-protected:wanted-kept-got-deleted']);
  assert.equal(conflict.requiresConfirmation, true);
});

test('post-delete query failure is unverified, never deleted (#1182)', () => {
  const failed = classifyPostDeleteQuery({
    ecs: { status: 'error' },
    eip: { status: 'timeout' },
    dataDisks: [{ id: 'vol-a', status: 'forbidden' }],
  });
  assert.equal(failed.ecs, 'unverified');
  assert.equal(failed.eip, 'unverified');
  assert.deepEqual(failed.dataDisks, [{ id: 'vol-a', state: 'unverified' }]);
  assert.ok(![failed.ecs, failed.eip, failed.dataDisks[0].state].includes('deleted'));
});

test('all simulated delete scenarios produce the documented retention outcome (#1182)', () => {
  for (const scenario of DELETE_SCENARIOS) {
    const plan = planDeleteRetention(scenario.record);
    assert.equal(plan.eip?.state ?? null, scenario.expect.eip, scenario.name);
    assert.equal(plan.systemDisk?.state ?? null, scenario.expect.systemDisk, scenario.name);
    assert.deepEqual(plan.dataDisks, scenario.expect.dataDisks, scenario.name);
    assert.equal(plan.requiresConfirmation, scenario.expect.requiresConfirmation, scenario.name);
    if (scenario.expect.conflicts) {
      assert.deepEqual(plan.conflicts, scenario.expect.conflicts, scenario.name);
    }
  }
});

test('all simulated post-delete scenarios classify each resource independently (#1182)', () => {
  for (const scenario of POST_DELETE_SCENARIOS) {
    const status = classifyPostDeleteQuery(scenario.results);
    assert.equal(status.ecs, scenario.expect.ecs, scenario.name);
    assert.equal(status.eip, scenario.expect.eip, scenario.name);
    assert.deepEqual(status.dataDisks, scenario.expect.dataDisks, scenario.name);
  }
});
