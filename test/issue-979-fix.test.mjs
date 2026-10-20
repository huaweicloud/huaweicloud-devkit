import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

// #979 D3-S7: compound web-app deployment intents must decompose into multiple
// service targets, and RDS creation must surface its VPC/subnet/security-group
// prerequisite chain. Single-target routing must not regress.

test('service_catalog decomposes compound web-app + RDS deployment intent into multiple targets (#979 D3-S7)', async () => {
  const zh = await callTool('huaweicloud_service_catalog', { intent: '部署 Web 应用 + RDS' });
  // Deployment target (Sandbox/DevStation) AND RDS must both be recommended.
  assert.ok(zh.recommendedServices.includes('RDS'), 'RDS target missing');
  assert.ok(
    zh.recommendedServices.includes('Sandbox') || zh.recommendedServices.includes('DevStation'),
    'deployment target missing',
  );
  // Deployment skill first (compound intent is deployment-shaped).
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(zh.recommendedSkills.includes('huawei-rds'));
  // Explicit compound decomposition listing every matched target.
  assert.ok(Array.isArray(zh.compoundTargets) && zh.compoundTargets.includes('RDS'));
  assert.ok(zh.compoundTargets.includes('Sandbox') || zh.compoundTargets.includes('DevStation'));

  const en = await callTool('huaweicloud_service_catalog', { intent: 'deploy a web app with an rds database' });
  assert.ok(en.recommendedServices.includes('RDS'));
  assert.ok(en.recommendedServices.includes('Sandbox'));
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(Array.isArray(en.compoundTargets) && en.compoundTargets.includes('RDS'));
});

test('service_catalog routes pure web-app deployment intent to the deployment target (#979 D3-S7)', async () => {
  const zh = await callTool('huaweicloud_service_catalog', { intent: '部署 Web 应用' });
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(zh.recommendedServices.includes('Sandbox'));
  // Single matched route → no compoundTargets field.
  assert.equal(zh.compoundTargets, undefined);
});

test('service_catalog surfaces the VPC/subnet/security-group prerequisite chain for RDS creation (#979 D3-S7)', async () => {
  const zh = await callTool('huaweicloud_service_catalog', { intent: '创建一个 RDS 数据库实例' });
  assert.ok(Array.isArray(zh.prerequisites), 'prerequisites missing for RDS creation intent');
  assert.equal(zh.prerequisites.length, 3);
  assert.deepEqual(
    zh.prerequisites.map((p) => p.operation),
    ['CreateVpc', 'CreateSubnet', 'CreateSecurityGroup'],
  );
  for (const step of zh.prerequisites) {
    assert.equal(step.service, 'VPC');
    assert.equal(step.skill, 'huawei-vpc');
    assert.ok(step.goal.length > 0);
  }
  assert.deepEqual(
    zh.prerequisites.map((p) => p.order),
    [1, 2, 3],
  );
  // The prerequisite skill must be recommended alongside huawei-rds.
  assert.ok(zh.recommendedSkills.includes('huawei-rds'));
  assert.ok(zh.recommendedSkills.includes('huawei-vpc'));

  const en = await callTool('huaweicloud_service_catalog', { intent: 'create an rds mysql instance' });
  assert.ok(Array.isArray(en.prerequisites));
  assert.deepEqual(
    en.prerequisites.map((p) => p.operation),
    ['CreateVpc', 'CreateSubnet', 'CreateSecurityGroup'],
  );
  assert.ok(en.recommendedSkills.includes('huawei-vpc'));
});

test('service_catalog keeps query-only RDS intent free of prerequisites (#979 D3-S7)', async () => {
  const result = await callTool('huaweicloud_service_catalog', { intent: '查询数据库实例信息' });
  assert.ok(result.recommendedServices.includes('RDS'));
  assert.equal(result.prerequisites, undefined);
  assert.equal(result.compoundTargets, undefined);
});

test('service_catalog single-target routing does not regress (#979 D3-S7)', async () => {
  // Pure storage intent must keep OBS first, not sandbox.
  const obs = await callTool('huaweicloud_service_catalog', { intent: 'store files in an obs bucket' });
  assert.ok(obs.recommendedSkills.includes('huawei-obs'));
  assert.notEqual(obs.recommendedSkills[0], 'huawei-sandbox');

  // Pure ECS intent stays single-target.
  const ecs = await callTool('huaweicloud_service_catalog', { intent: '创建一台弹性云服务器' });
  assert.ok(ecs.recommendedServices.includes('ECS'));
  assert.equal(ecs.compoundTargets, undefined);
  assert.equal(ecs.prerequisites, undefined);

  // Static website to OBS: both targets, storage skill NOT reordered ahead of sandbox.
  const site = await callTool('huaweicloud_service_catalog', { intent: '部署静态网站到对象存储' });
  assert.ok(site.recommendedServices.includes('OBS'));
  assert.equal(site.recommendedSkills[0], 'huawei-sandbox');
});
