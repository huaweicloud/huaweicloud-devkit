import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planHcloudCommand, resetStsInjectFailureCache } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const PUBLIC_SSH_RULE = [
  'VPC',
  'CreateSecurityGroupRule',
  '--security_group_rule.direction=ingress',
  '--security_group_rule.port_range_min=22',
  '--security_group_rule.port_range_max=22',
  '--security_group_rule.protocol=tcp',
  '--security_group_rule.remote_ip_prefix=0.0.0.0/0',
];

const READ_ONLY_LIST = ['ECS', 'ListServersDetails', '--cli-region=cn-north-4'];

function fakeHcloudExecutable(source) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-issue1133-bin-'));
  const script = join(dir, 'fake-hcloud');
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(script, 0o755);
  return { dir, script };
}

async function withTempAuthHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'huaweicloud-issue1133-home-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
  };
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_CONFIG_PATH = join(home, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  resetStsInjectFailureCache();
  try {
    return await fn(home);
  } finally {
    clearRuntimeCredentials();
    resetStsInjectFailureCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('D4-19: plan denies a public admin port with a machine-readable finding', async () => {
  await withTempAuthHome(async () => {
    const plan = await callTool('huaweicloud_plan_cli_command', { args: PUBLIC_SSH_RULE });
    assert.equal(plan.safeToRun, false);
    assert.equal(plan.classification.decision, 'deny');
    assert.equal(plan.blockedByRiskRule, true);
    assert.equal(
      plan.findings.some((f) => f.ruleId === 'hwc-network-public-admin-port'),
      true,
    );
    assert.equal(plan.findings.find((f) => f.ruleId === 'hwc-network-public-admin-port').severity, 'deny');
  });
});

test('D4-19: read-only low-risk plan stays allow and has no risk block', async () => {
  await withTempAuthHome(async () => {
    const plan = await callTool('huaweicloud_plan_cli_command', { args: READ_ONLY_LIST });
    assert.equal(plan.classification.decision, 'allow');
    assert.equal(plan.safeToRun, true);
    assert.equal(plan.blockedByRiskRule, undefined);
    assert.equal(
      plan.findings.some((f) => f.ruleId === 'hwc-network-public-admin-port'),
      false,
    );
  });
});

test('D4-19: warn-level risk does not upgrade to deny but surfaces in warnings', async () => {
  await withTempAuthHome(async () => {
    const plan = planHcloudCommand(['VPC', 'ListVpcs', '--password=plain']);
    assert.equal(plan.classification.decision, 'allow');
    assert.equal(plan.safeToRun, true);
    assert.equal(plan.blockedByRiskRule, undefined);
    assert.ok(
      plan.warnings.some(
        (warning) =>
          typeof warning === 'string' &&
          warning.includes('hwc-command-secret-in-arg') &&
          warning.includes('warn') &&
          warning.includes('plaintext password'),
      ),
      JSON.stringify(plan.warnings),
    );
  });
});

test('D4-19: run_approved_command rejects a risk-denied plan without executing it', async () => {
  await withTempAuthHome(async (home) => {
    const marker = join(home, 'executed.marker');
    const { dir, script } = fakeHcloudExecutable(
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    );
    process.env.HCLOUD_BIN = script;
    try {
      const plan = await callTool('huaweicloud_plan_cli_command', { args: PUBLIC_SSH_RULE });
      assert.equal(plan.blockedByRiskRule, true);
      const result = await callTool('huaweicloud_run_approved_command', {
        args: PUBLIC_SSH_RULE,
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONFIRM_BLOCKED_BY_RISK_RULE');
      assert.equal(
        result.findings.some((f) => f.ruleId === 'hwc-network-public-admin-port'),
        true,
      );
      assert.equal(existsSync(marker), false, 'risk-denied command must not execute');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('D3-B3: injected placeholder STS fails auth, falls back to the KooCLI profile once, then skips injection', async () => {
  await withTempAuthHome(async (home) => {
    const callLog = join(home, 'calls.log');
    const { dir, script } = fakeHcloudExecutable(`
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (args.some((a) => a.startsWith('--cli-access-key='))) {
  console.log(JSON.stringify({ error_code: 'APIGW.0301', error_msg: 'Incorrect IAM authentication information' }));
  process.exit(1);
}
console.log(JSON.stringify({ count: 2, servers: [{ id: 'srv-1' }, { id: 'srv-2' }] }));
`);
    process.env.HCLOUD_BIN = script;
    setRuntimeCredentials('PLACEHOLDER_AK_1133', 'PLACEHOLDER_SK_1133', 'PLACEHOLDER_TOKEN_1133', 'cn-north-4');
    try {
      const first = await callTool('huaweicloud_run_readonly_command', { args: READ_ONLY_LIST, maxRetries: 0 });
      assert.equal(first.ok, true);
      assert.match(first.stdout, /srv-1/);
      assert.deepEqual(first.credentialFallback, { from: 'sts-inject', to: 'koocli-profile' });
      assert.equal(JSON.stringify(first).includes('PLACEHOLDER_TOKEN_1133'), false, 'credentials must stay redacted');
      const firstCalls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(firstCalls.length, 2, 'first call tries injection then profile fallback');
      assert.ok(firstCalls[0].includes('--cli-access-key='), 'first attempt injects STS');
      assert.equal(firstCalls[1].includes('--cli-access-key='), false, 'fallback uses the KooCLI profile');

      const second = await callTool('huaweicloud_run_readonly_command', { args: READ_ONLY_LIST, maxRetries: 0 });
      assert.equal(second.ok, true);
      const secondCalls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(secondCalls.length, 3, 'negative cache skips injection on the next call');
      assert.equal(secondCalls[2].includes('--cli-access-key='), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('D3-B3: a live STS injection that succeeds is unchanged and still redacted', async () => {
  await withTempAuthHome(async (home) => {
    const callLog = join(home, 'calls.log');
    const { dir, script } = fakeHcloudExecutable(`
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ count: 1, servers: [{ id: 'live-srv' }] }));
`);
    process.env.HCLOUD_BIN = script;
    setRuntimeCredentials('LIVE_AK_1133', 'LIVE_SK_1133', 'LIVE_TOKEN_1133', 'cn-north-4');
    try {
      const result = await callTool('huaweicloud_run_readonly_command', { args: READ_ONLY_LIST, maxRetries: 0 });
      assert.equal(result.ok, true);
      assert.equal(result.credentialFallback, undefined);
      assert.equal(JSON.stringify(result).includes('LIVE_TOKEN_1133'), false, 'injected token must be redacted');
      const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('--cli-access-key='), 'live STS is still injected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('D3-B3: a true STS failure with no usable profile stays a failure (never silent allow)', async () => {
  await withTempAuthHome(async () => {
    const { dir, script } = fakeHcloudExecutable(`
console.log(JSON.stringify({ error_code: 'APIGW.0301', error_msg: 'Incorrect IAM authentication information' }));
process.exit(1);
`);
    process.env.HCLOUD_BIN = script;
    setRuntimeCredentials('DOOMED_AK_1133', 'DOOMED_SK_1133', 'DOOMED_TOKEN_1133', 'cn-north-4');
    try {
      const result = await callTool('huaweicloud_run_readonly_command', { args: READ_ONLY_LIST, maxRetries: 0 });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'APIGW.0301');
      assert.equal(result.firstAttempt.errorCode, 'APIGW.0301');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
