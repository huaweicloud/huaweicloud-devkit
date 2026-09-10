import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateArtifacts,
  evaluateCommandRisk,
  evaluateDeployPlan,
  loadRiskRules,
} from '../plugins/huaweicloud-core/src/risk-rule-engine.mjs';

test('loadRiskRules loads the public catalog', () => {
  const catalog = loadRiskRules();
  assert.equal(catalog.version, '0.1.0');
  assert.ok(catalog.rules.some((rule) => rule.id === 'hwc-network-public-admin-port'));
});

test('evaluateCommandRisk blocks public SSH exposure', () => {
  const result = evaluateCommandRisk(
    'hcloud VPC CreateSecurityGroupRule --security_group_rule.protocol=tcp --security_group_rule.port_range_min=22 --security_group_rule.port_range_max=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
  assert.match(result.findings[0].message, /public/i);
});

test('evaluateCommandRisk warns on high-cost resource shape', () => {
  const result = evaluateCommandRisk('hcloud CCE CreateCluster --node_pool.max_node_count=80 --node_pool.name=preview');
  assert.equal(result.decision, 'warn');
  assert.equal(result.findings[0].ruleId, 'hwc-cost-unbounded-scale');
});

test('evaluateArtifacts detects broad IAM policy in generated files', () => {
  const result = evaluateArtifacts([
    {
      path: 'iam-policy.json',
      content: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
    },
  ]);
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('evaluateArtifacts detects broad IAM policy when Action is a JSON array', () => {
  const result = evaluateArtifacts([
    {
      path: 'iam-policy.json',
      content: '{"Statement":[{"Effect":"Allow","Action":["*"],"Resource":["*"]}]}',
    },
    {
      path: 'agency-policy.json',
      content: '{"Statement":[{"Effect":"Allow","Action":["*:*"],"Resource":"*"}]}',
    },
  ]);
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('evaluateCommandRisk blocks OBS public read-write ACL changes', () => {
  const result = evaluateCommandRisk('hcloud obs chattri obs://bucket -acl=public-read-write');
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-obs-anonymous-write');
});

test('evaluateCommandRisk blocks encoded shell payload execution', () => {
  const result = evaluateCommandRisk('echo ZWNobyBoaQ== | base64 -d | bash');
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-command-encoded-shell-exec');
});

test('evaluateCommandRisk treats spaced public CIDR as public exposure', () => {
  const result = evaluateCommandRisk(
    'hcloud VPC CreateSecurityGroupRule --security_group_rule.protocol=tcp --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0 /0',
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
});

test('evaluateDeployPlan detects quoted FunctionGraph public no-auth plans', () => {
  const result = evaluateDeployPlan({
    service: 'FunctionGraph',
    trigger: {
      type: 'APIG',
      auth: 'NONE',
    },
  });
  assert.equal(result.decision, 'warn');
  assert.equal(result.findings[0].ruleId, 'hwc-functiongraph-public-no-auth');
});

test('evaluateDeployPlan warns when sandbox plan lacks cleanup metadata', () => {
  const result = evaluateDeployPlan({
    environment: 'preview',
    resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
  });
  assert.equal(result.decision, 'warn');
  assert.equal(result.findings[0].ruleId, 'hwc-sandbox-missing-ttl');
});

test('evaluateDeployPlan allows sandbox plan with cleanup metadata', () => {
  const result = evaluateDeployPlan({
    environment: 'preview',
    owner: 'developer',
    ttl: '2h',
    cleanup: 'delete stack after test',
    resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.findings.length, 0);
});

test('evidence snippets redact secret-shaped values', () => {
  const result = evaluateCommandRisk(
    'hcloud ECS CreateServers --server.adminPass=PlainText123! --security_group_rule.remote_ip_prefix=0.0.0.0/0 --security_group_rule.port_range_min=22',
  );
  assert.equal(result.decision, 'deny');
  assert.doesNotMatch(JSON.stringify(result), /PlainText123/);
  assert.match(JSON.stringify(result), /<redacted>/);
});

test('evaluateCommandRisk warns on prefixed delete family (Nova*)', () => {
  for (const op of ['NovaDeleteServer', 'NovaDeleteKeypair', 'NovaDeleteServerGroup', 'NovaDeleteServerMetadataItem']) {
    const result = evaluateCommandRisk(`hcloud ECS ${op} --x=1`);
    assert.equal(result.decision, 'warn', `${op} should warn`);
    assert.equal(result.findings[0].ruleId, 'hwc-destructive-delete-operation');
  }
});

test('evaluateCommandRisk warns on reset family (ResetServerPassword etc.)', () => {
  for (const op of ['ResetServerPassword', 'ResetServerVnc', 'ResetServerMetadata']) {
    const result = evaluateCommandRisk(`hcloud ECS ${op} --server_id=x`);
    assert.equal(result.decision, 'warn', `${op} should warn`);
    assert.equal(result.findings[0].ruleId, 'hwc-destructive-reset-operation');
  }
});

test('evaluateCommandRisk still allows read-only Nova list ops', () => {
  const result = evaluateCommandRisk('hcloud ECS NovaListServers --limit=1');
  assert.equal(result.decision, 'allow');
  assert.equal(result.findings.length, 0);
});

test('evaluateCommandRisk blocks IAM admin policy creation via CLI flag', () => {
  const result = evaluateCommandRisk(
    'hcloud IAM CreatePolicy --policy.name=admin-all --policy.action=*:*:* --policy.effect=Allow',
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('evaluateCommandRisk warns on batch reset family (BatchReset*)', () => {
  const cases = [
    ['ECS', 'BatchResetServersPassword'],
    ['DRS', 'BatchResetPassword'],
    ['ModelArts', 'BatchResetPoolNodes'],
  ];
  for (const [svc, op] of cases) {
    const result = evaluateCommandRisk(`hcloud ${svc} ${op} --x=1`);
    assert.equal(result.decision, 'warn', `${svc} ${op} should warn`);
    assert.equal(result.findings[0].ruleId, 'hwc-destructive-reset-operation');
  }
});

test('evaluateCommandRisk does not flag delete-protection toggles as destructive', () => {
  for (const op of [
    'ShowDeleteProtection',
    'UpdateDeleteProtection',
    'EnableDeleteProtection',
    'DisableDeleteProtection',
  ]) {
    const result = evaluateCommandRisk(`hcloud ECS ${op} --server_id=x`);
    assert.equal(result.decision, 'allow', `${op} should not be flagged as destructive delete`);
  }
});
