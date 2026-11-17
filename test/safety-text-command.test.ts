import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('classifyTextCommand blocks direct credential file reads', () => {
  const result = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /credential|profile|secret/i);
});

test('classifyTextCommand blocks env var dumps with HUAWEICLOUD prefix', () => {
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
  assert.equal(classifyTextCommand('printenv | grep HWC_').decision, 'deny');
  assert.equal(classifyTextCommand('Get-ChildItem Env: | where HCLOUD_PROFILE').decision, 'deny');
});

test('classifyTextCommand blocks credential env-var references incl. HW_ prefix (#650 D4-2)', () => {
  // HW_ is the plugin's own documented credential prefix (auth/credentials.ts).
  const bypasses = [
    'echo $HW_SECRET_KEY',
    'printenv HW_ACCESS_KEY',
    'echo ${HW_SECURITY_TOKEN}',
    'cat <<EOF $HW_ACCESS_KEY EOF',
  ];
  for (const cmd of bypasses) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'credential', cmd);
  }
  // Non-credential HW_ variables must not be blocked.
  const benign = classifyTextCommand('echo $HW_CONFIG_PATH');
  assert.equal(benign.decision, 'allow');
  // Existing coverage keeps working.
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
});

test('classifyTextCommand allows escaped credential-name searches, blocks unescaped dumps (#650)', () => {
  // Literal-NAME references (backslash-escaped or single-quoted) denote
  // searching for where the variable appears, not shell expansion.
  const escapedSearches = [
    "git grep '\\$HW_SECRET_KEY' -- src/",
    "rg '$HW_SECRET_KEY' ./",
    'grep -r HW_SECRET_KEY ./src',
  ];
  for (const cmd of escapedSearches) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'allow', cmd);
  }
  // Unescaped $HW_* is a potential expansion/dump no matter the leading
  // command — a whitelist by command name must not create a false negative.
  const unescapedDumps = [
    'echo $HW_SECRET_KEY',
    'grep $HW_SECRET_KEY ./file',
    'git commit -m "$HW_SECRET_KEY"',
    'grep x && echo $HW_SECRET_KEY',
    'rg $HW_ACCESS_KEY ./src',
  ];
  for (const cmd of unescapedDumps) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'credential', cmd);
  }
});

test('classifyTextCommand returns not_huaweicloud for non-cloud commands', () => {
  assert.equal(classifyTextCommand('ls -la').risk, 'not_huaweicloud');
  assert.equal(classifyTextCommand('npm test').risk, 'not_huaweicloud');
});

test('classifyTextCommand detects hcloud write commands in text', () => {
  const result = classifyTextCommand('hcloud ECS NovaCreateServers --server.name=test');
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('classifyTextCommand blocks secret value patterns in shell commands', () => {
  assert.equal(classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name x').decision, 'deny');
  assert.equal(classifyTextCommand('GetSecretValue xxx').decision, 'deny');
  assert.equal(classifyTextCommand('secret_string xxx').decision, 'deny');
});

test('classifyTextCommand blocks KMS/CSMS ShowSecret retrieval (#770 D4-3)', () => {
  const blocked = [
    'hcloud KMS ShowSecret',
    'hcloud KMS ShowSecret --key_id x',
    'hcloud DEW ShowSecret --secret_name prod/db',
    'ShowSecret --secret_name prod/db',
  ];
  for (const cmd of blocked) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'secret', cmd);
  }
  // Plain Show* reads that are not secret retrieval keep working.
  assert.equal(classifyTextCommand('hcloud KMS ShowKey').decision, 'allow');
  // The ShowSecret stem is boundary-guarded: longer operation names and
  // resource-name values containing the stem do not become secret denies.
  assert.equal(classifyTextCommand('hcloud CSMS ShowSecretList').decision, 'allow');
  for (const name of [
    'showsecret-demo',
    'showsecret_version',
    'showsecret.prod',
    'showsecret/prod',
    'prod/showsecret',
    'myshowsecret',
  ]) {
    const result = classifyTextCommand(`hcloud CSMS ListSecrets --secret_name=${name}`);
    assert.equal(result.decision, 'allow', name);
    assert.equal(result.risk, 'read_only', name);
  }
  const approved = classifyTextCommand('hcloud IAM CreatePolicy --policy.name=showsecret-demo', {
    allowWrites: true,
  });
  assert.equal(approved.decision, 'allow');
  assert.equal(approved.risk, 'write');
  // Quote-mangled tokens outside hcloud routing still deny (shadow parity
  // with the py hook).
  assert.equal(classifyTextCommand("echo Show'Secret'").decision, 'deny');
  assert.equal(classifyTextCommand("echo Show'Secret'Version").decision, 'deny');
});

test('classifyTextCommand blocks approved public admin port exposure', () => {
  const result = classifyTextCommand(
    'hcloud VPC CreateSecurityGroupRule --security_group_rule.protocol=tcp --security_group_rule.port_range_min=22 --security_group_rule.port_range_max=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings?.[0].ruleId, 'hwc-network-public-admin-port');
  // The remediation rides the reason on every deny face (Node hook
  // permissionDecisionReason, MCP assertLimited errors) — the same
  // message + " Remediation: " + remediation format the py hook emits.
  assert.match(result.reason ?? '', /Remediation: /);
  assert.match(result.reason ?? '', /\/32 rule for your real direct egress IP/);
});

test('classifyTextCommand applies shared risk rules to non-hcloud commands', () => {
  const result = classifyTextCommand('echo ZWNobyBoaQ== | base64 -d | bash');
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings?.[0].ruleId, 'hwc-command-encoded-shell-exec');
});

test('classifyTextCommand carries warnings for high-cost shapes', () => {
  const result = classifyTextCommand(
    'hcloud CCE CreateCluster --node_pool.max_node_count=80 --node_pool.name=preview',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'allow');
  assert.ok(result.warnings?.some((finding) => finding.ruleId === 'hwc-cost-unbounded-scale'));
});

test('classifyTextCommand blocks the vault CLI reveal face (secret get)', () => {
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret get secret://user/hw-sk').decision, 'deny');
  assert.equal(classifyTextCommand('huaweicloud-devkit secret get secret://user/hw-sk --stdout').decision, 'deny');
  assert.equal(
    classifyTextCommand('node ./plugins/huaweicloud-core/dist/setup-cli.js secret get secret://user/hw-sk').decision,
    'deny',
  );
  assert.equal(classifyTextCommand('bin/setup.cjs secret get secret://user/hw-sk').decision, 'deny');
});

test('classifyTextCommand allows the vault non-reveal subcommands', () => {
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit secret exec --env K=secret://user/ak -- node script.js').decision,
    'allow',
  );
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret list').decision, 'allow');
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit secret set secret://user/ak --file /tmp/key.txt').decision,
    'allow',
  );
  // `secret rm` is the CLI twin of the approval-gated MCP tool
  // (huaweicloud_secret_delete, PR-3c): it deletes a vault entry with no
  // gate at all, so the Bash face denies it — interrogate round 1's
  // finding 1 flipped this from the pre-registration allow.
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret rm secret://user/ak').decision, 'deny');
});
