import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

function setFakeHcloud(nodeScript) {
  const oldEnv = {
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    HCLOUD_BIN_ARGS_JSON: process.env.HCLOUD_BIN_ARGS_JSON,
  };
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([nodeScript]);
  return () => {
    if (oldEnv.HCLOUD_BIN === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = oldEnv.HCLOUD_BIN;
    if (oldEnv.HCLOUD_BIN_ARGS_JSON === undefined) delete process.env.HCLOUD_BIN_ARGS_JSON;
    else process.env.HCLOUD_BIN_ARGS_JSON = oldEnv.HCLOUD_BIN_ARGS_JSON;
  };
}

test('preflightSecurityGroupCheck catches dangerous SG via --server.security_groups.N.id (B1+B2 fix)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-test-'));
  const script = join(dir, `fake-${randomBytes(4).toString('hex')}.mjs`);

  writeFileSync(
    script,
    `
console.log(JSON.stringify({
  request_id: "req-1",
  security_group_rules: [{
    id: "rule-abc",
    direction: "ingress",
    remote_ip_prefix: "0.0.0.0/0",
    multiport: "22",
    protocol: "tcp",
    security_group_id: "sg-123"
  }]
}));
`,
    'utf8',
  );

  const restoreHcloud = setFakeHcloud(script);

  try {
    const { planHcloudCommand } = await import('../plugins/huaweicloud-core/src/hcloud-cli.ts');

    const plan = planHcloudCommand(
      [
        'ECS',
        'CreateServers',
        '--cli-region=cn-north-4',
        '--server.security_groups.1.id=77216397-2c1b-4d96-b1e7-0e57a3176498',
        '--server.flavorRef=ac7.large.2',
        '--server.imageRef=img',
        '--server.nics.1.subnet_id=sub',
      ],
      { allowWrites: true },
    );

    assert.ok(plan.sgFindings.length > 0, 'B1+B2 fix: should have sg findings');
    assert.equal(plan.classification.decision, 'deny', 'B1+B2 fix: should deny ECS on dangerous SG reuse');
    assert.match(plan.sgFindings[0].message, /22/);
    assert.match(plan.sgFindings[0].message, /77216397/);
  } finally {
    restoreHcloud();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('preflightSecurityGroupCheck passes when SG has only egress rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-test-'));
  const script = join(dir, `fake-${randomBytes(4).toString('hex')}.mjs`);

  writeFileSync(
    script,
    `
console.log(JSON.stringify({
  request_id: "req-3",
  security_group_rules: [{
    id: "rule-safe",
    direction: "egress",
    remote_ip_prefix: "0.0.0.0/0",
    protocol: "tcp",
    multiport: "22",
    security_group_id: "sg-789"
  }]
}));
`,
    'utf8',
  );

  const restoreHcloud = setFakeHcloud(script);

  try {
    const { planHcloudCommand } = await import('../plugins/huaweicloud-core/src/hcloud-cli.ts');

    const plan = planHcloudCommand(
      [
        'ECS',
        'CreateServers',
        '--cli-region=cn-north-4',
        '--server.security_groups.1.id=sg-789',
        '--server.flavorRef=ac7.large.2',
        '--server.imageRef=img',
        '--server.nics.1.subnet_id=sub',
      ],
      { allowWrites: true },
    );

    assert.equal(plan.sgFindings.length, 0, 'egress rules should be ignored');
    assert.equal(plan.classification.decision, 'allow');
  } finally {
    restoreHcloud();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('preflightSecurityGroupCheck still works with --security_group_id (backward compatible)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-test-'));
  const script = join(dir, `fake-${randomBytes(4).toString('hex')}.mjs`);

  writeFileSync(
    script,
    `
console.log(JSON.stringify({
  request_id: "req-4",
  security_group_rules: [{
    id: "rule-old",
    direction: "ingress",
    remote_ip_prefix: "0.0.0.0/0",
    multiport: "3306",
    protocol: "tcp",
    security_group_id: "sg-old"
  }]
}));
`,
    'utf8',
  );

  const restoreHcloud = setFakeHcloud(script);

  try {
    const { planHcloudCommand } = await import('../plugins/huaweicloud-core/src/hcloud-cli.ts');

    const plan = planHcloudCommand(
      [
        'ECS',
        'CreateServers',
        '--cli-region=cn-north-4',
        '--security_group_id=sg-old',
        '--server.flavorRef=ac7.large.2',
        '--server.imageRef=img',
        '--server.nics.1.subnet_id=sub',
      ],
      { allowWrites: true },
    );

    assert.ok(plan.sgFindings.length > 0, 'old format should still work');
    assert.equal(plan.classification.decision, 'deny');
  } finally {
    restoreHcloud();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
