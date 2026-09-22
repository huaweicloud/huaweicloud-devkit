import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  redactSecrets,
  computePolicyHash,
  computePolicyDiff,
  syncPolicyFromSource,
  policyFilePath,
} from '../plugins/huaweicloud-core/src/safety-policy.mjs';

test('redactSecrets removes credential-shaped values recursively', () => {
  const redacted = redactSecrets({
    profile: 'dev',
    access_key: 'example-access-key',
    nested: {
      secretAccessKey: 'example-secret-key',
      normal: 'visible',
    },
  });
  assert.equal(redacted.profile, 'dev');
  assert.equal(redacted.access_key, '<redacted>');
  assert.equal(redacted.nested.secretAccessKey, '<redacted>');
  assert.equal(redacted.nested.normal, 'visible');
});

test('redactSecrets redacts adminPass and password fields', () => {
  const redacted = redactSecrets({
    '--server.adminPass': 'MySecret123!',
    password: 'hunter2',
    normal_field: 'keep',
  });
  assert.equal(redacted['--server.adminPass'], '<redacted>');
  assert.equal(redacted.password, '<redacted>');
  assert.equal(redacted.normal_field, 'keep');
});

test('redactSecrets handles array values', () => {
  const redacted = redactSecrets([
    { name: 'prod', secret_key: 'sk-xxx' },
    { name: 'dev', normal: 'value' },
  ]);
  assert.equal(redacted[0].secret_key, '<redacted>');
  assert.equal(redacted[1].normal, 'value');
});

test('redactSecrets handles string values with key=value patterns', () => {
  const out = redactSecrets('AK=HPUAI12345\nSK=abcdef\nnormal output');
  assert.match(out, /<redacted>/);
  assert.match(out, /normal output/);
  assert.doesNotMatch(out, /HPUAI12345/);
});

test('redactSecrets masks opaque blob keys (user_data / metadata / private_key) entirely', () => {
  const redacted = redactSecrets([
    'ECS',
    'CreateServers',
    '--server.user_data=ZXhwb3J0IEFQUF9TRUNSRVQ9czNjcjN0',
    '--server.user_data=echo TOKEN=abc123 >> /etc/x',
    '--server.metadata.db_password=secret123',
    '--keypair.private_key=-----BEGIN RSA PRIVATE KEY-----',
  ]);
  for (const arg of redacted) {
    assert.doesNotMatch(arg, /SECRET|TOKEN|abc123|secret123|RSA|PRIVATE/);
  }
  assert.match(redacted[2], /user_data=<redacted>/);
  assert.match(redacted[3], /user_data=<redacted>/);
  assert.match(redacted[4], /metadata.db_password=<redacted>/);
  assert.match(redacted[5], /private_key=<redacted>/);
});

test('classifyTextCommand blocks direct credential file reads', () => {
  const result = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /credential|profile|secret/i);
});

test('classifyTextCommand blocks env var dumps with HUAWEICLOUD prefix', () => {
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
  assert.equal(classifyTextCommand('printenv | grep HWC_').decision, 'deny');
  assert.equal(classifyTextCommand('Get-ChildItem Env: | where HCLOUD').decision, 'deny');
});

test('classifyHcloudArgs blocks secret value reads', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecretVersion', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /secret value/i);
});

test('classifyHcloudArgs blocks unapproved writes', () => {
  const result = classifyHcloudArgs(['ECS', 'NovaCreateServers', '--body', '{}']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /write operation/i);
});

test('classifyHcloudArgs blocks Apply* operations as writes (#644)', () => {
  // EIP ApplyEip was classified as unknown_read and allowed through (issue #644 EXP-E04).
  const applyWrites = [
    ['EIP', 'ApplyEip'],
    ['WAF', 'ApplyCertificateToHost'],
    ['CDN', 'ApplyDomainTemplate'],
    ['RDS', 'ApplyConfigurationAsync'],
  ];
  for (const args of applyWrites) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs keeps read operations containing Apply substring as read-only', () => {
  const result = classifyHcloudArgs(['ECS', 'ListConfigurationApplyHistories']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'read_only');
});

test('classifyHcloudArgs allows local help for Apply operations', () => {
  const result = classifyHcloudArgs(['EIP', 'ApplyEip', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyTextCommand blocks credential env-var references incl. HW_ prefix (#650 D4-2)', () => {
  // HW_ is the plugin's own documented credential prefix (auth/credentials.mjs).
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

test('classifyHcloudArgs unwraps shell-wrapped hcloud write commands (#650 D4-16)', () => {
  const wrapped = [
    ['bash', '-c', 'hcloud ECS CreateServers --flavor=x'],
    ['sh', '-c', 'hcloud CCE DeleteCluster --cluster_id=x'],
    ['bash', '-c', 'sudo hcloud OBS rm obs://bucket/obj'],
    ['sudo', 'hcloud', 'ECS', 'CreateServers'],
    ['/bin/bash', '-c', 'bash -c "hcloud ECS DeleteServers --servers=[]"'],
  ];
  for (const args of wrapped) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs detects hcloud write commands mid-concatenation (#650 review)', () => {
  const concatenated = [
    ['bash', '-c', 'echo x; hcloud ECS CreateServers --flavor=x'],
    ['bash', '-c', 'echo done && hcloud CCE DeleteCluster --cluster_id=x'],
    ['sudo', 'sh', '-c', 'hcloud OBS rm obs://b/x && echo ok'],
  ];
  for (const args of concatenated) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
  const textResult = classifyTextCommand('echo x && hcloud ECS CreateServers --flavor=x');
  assert.equal(textResult.decision, 'deny');
  assert.equal(textResult.risk, 'write');
  // Read-only hcloud prefix keeps working.
  const readResult = classifyTextCommand('hcloud ECS ListServers; echo done');
  assert.equal(readResult.decision, 'allow');
  assert.equal(readResult.risk, 'read_only');
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

test('classifyHcloudArgs allows local help for write operations', () => {
  const result = classifyHcloudArgs(['ECS', 'CreateServers', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyHcloudArgs allows read-only list and show operations', () => {
  assert.equal(classifyHcloudArgs(['ECS', 'NovaListServers']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['ECS', 'ListServersDetails']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['VPC', 'ShowVpc']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IMS', 'GlanceShowImage']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IAM', 'KeystoneListUsers']).decision, 'allow');
});

test('classifyHcloudArgs blocks obsutil write commands', () => {
  const writes = ['mb', 'cp', 'mv', 'rm', 'delete', 'mkdir', 'sync', 'chattri', 'bucketpolicy'];
  for (const op of writes) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'deny', `obs ${op} should be blocked`);
  }
});

test('classifyHcloudArgs allows obsutil read commands', () => {
  const reads = ['ls', 'stat', 'help', 'version'];
  for (const op of reads) {
    assert.equal(classifyHcloudArgs(['obs', op]).decision, 'allow', `obs ${op} should be allowed`);
  }
});

test('classifyHcloudArgs blocks execution operations (Invoke, Trigger, Deploy)', () => {
  const execs = ['InvokeFunction', 'SyncInvokeFunction', 'AsyncInvokeFunction', 'Send'];
  for (const op of execs) {
    assert.equal(classifyHcloudArgs(['FunctionGraph', op]).decision, 'deny', `${op} should be blocked as execution`);
  }
  assert.equal(classifyHcloudArgs(['ECS', 'StartServers']).decision, 'deny', 'ECS StartServers should be blocked');
  assert.equal(classifyHcloudArgs(['ECS', 'RebootServers']).decision, 'deny', 'ECS RebootServers should be blocked');
});

test('classifyHcloudArgs blocks hcloud configure show without allowCredentialRead', () => {
  const result = classifyHcloudArgs(['configure', 'show']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'credential');
});

test('classifyHcloudArgs rejects empty args', () => {
  assert.equal(classifyHcloudArgs([]).decision, 'deny');
  assert.equal(classifyHcloudArgs([]).risk, 'invalid');
});

test('classifyHcloudArgs allows version commands', () => {
  assert.equal(classifyHcloudArgs(['version']).risk, 'local_metadata');
  assert.equal(classifyHcloudArgs(['--version']).risk, 'local_metadata');
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

test('classifyTextCommand blocks approved public admin port exposure', () => {
  const result = classifyTextCommand(
    'hcloud VPC CreateSecurityGroupRule --security_group_rule.protocol=tcp --security_group_rule.port_range_min=22 --security_group_rule.port_range_max=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
});

test('classifyTextCommand applies shared risk rules to non-hcloud commands', () => {
  const result = classifyTextCommand('echo ZWNobyBoaQ== | base64 -d | bash');
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings[0].ruleId, 'hwc-command-encoded-shell-exec');
});

test('classifyTextCommand carries warnings for high-cost shapes', () => {
  const result = classifyTextCommand(
    'hcloud CCE CreateCluster --node_pool.max_node_count=80 --node_pool.name=preview',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'allow');
  assert.ok(result.warnings.some((finding) => finding.ruleId === 'hwc-cost-unbounded-scale'));
});

test('existing credential and secret blocks still win before risk-rule warnings', () => {
  const credentialResult = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(credentialResult.decision, 'deny');
  assert.equal(credentialResult.risk, 'credential');
  assert.equal(Object.hasOwn(credentialResult, 'findings'), false);

  const secretResult = classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name prod/db');
  assert.equal(secretResult.decision, 'deny');
  assert.equal(secretResult.risk, 'secret');
});

// --- Issue #685: runtime policy hash verification & auto-sync ---

test('computePolicyHash returns a consistent SHA256 hex string', () => {
  const hash = computePolicyHash(policyFilePath());
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('computePolicyHash returns null for a missing file', () => {
  const hash = computePolicyHash(join(tmpdir(), 'nonexistent-policy-' + Date.now() + '.json'));
  assert.equal(hash, null);
});

test('computePolicyDiff detects added writeOperationPrefixes (#685)', () => {
  const oldPolicy = {
    version: '0.1.0',
    writeOperationPrefixes: ['Create', 'Delete', 'Update'],
    readOperationPrefixes: ['List', 'Show'],
  };
  const newPolicy = {
    version: '0.1.0',
    writeOperationPrefixes: ['Create', 'Delete', 'Update', 'Apply'],
    readOperationPrefixes: ['List', 'Show'],
  };
  const diff = computePolicyDiff(oldPolicy, newPolicy);
  assert.match(diff, /writeOperationPrefixes: 3→4/);
  assert.match(diff, /\+Apply/);
});

test('computePolicyDiff detects removed prefixes', () => {
  const oldPolicy = {
    writeOperationPrefixes: ['Create', 'Delete', 'Apply'],
    readOperationPrefixes: ['List', 'Show', 'Get'],
  };
  const newPolicy = {
    writeOperationPrefixes: ['Create', 'Delete'],
    readOperationPrefixes: ['List', 'Show', 'Get'],
  };
  const diff = computePolicyDiff(oldPolicy, newPolicy);
  assert.match(diff, /writeOperationPrefixes: 3→2/);
  assert.match(diff, /-Apply/);
});

test('computePolicyDiff returns empty string for identical policies', () => {
  const policy = { writeOperationPrefixes: ['Create', 'Delete'], readOperationPrefixes: ['List'] };
  assert.equal(computePolicyDiff(policy, policy), '');
});

test('computePolicyDiff returns empty string when oldPolicy is null (first install)', () => {
  const newPolicy = { writeOperationPrefixes: ['Create'] };
  assert.equal(computePolicyDiff(null, newPolicy), '');
});

test('computePolicyDiff reports version change', () => {
  const oldPolicy = { version: '0.1.0', writeOperationPrefixes: ['Create'] };
  const newPolicy = { version: '0.2.0', writeOperationPrefixes: ['Create'] };
  const diff = computePolicyDiff(oldPolicy, newPolicy);
  assert.match(diff, /version: 0\.1\.0→0\.2\.0/);
});

test('syncPolicyFromSource auto-syncs stale runtime policy and returns diff (#685)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'policy-sync-'));
  try {
    const runtimePolicyPath = join(tmpDir, 'safety', 'policy.json');
    const sourcePolicyPath = join(tmpDir, 'source', 'policy.json');

    // Stale runtime policy (missing Apply → ApplyEip misclassified as read-only)
    const stalePolicy = {
      version: '0.1.0',
      writeOperationPrefixes: ['Create', 'Delete', 'Update'],
      readOperationPrefixes: ['List', 'Show', 'Get', 'Describe', 'NovaList', 'NovaShow'],
      secretKeyNamePatterns: ['access[_-]?key'],
      credentialFilePatterns: ['\\.hcloud'],
      blockedConfigureSubcommands: ['show'],
      blockedSecretOperations: ['ShowSecretVersion'],
      safeTextReadCommands: ['rg'],
      blockedSandboxCommands: ['rm\\s+-rf\\s+/'],
      sandboxWriteTools: ['huaweicloud_sandbox_connect'],
    };
    // Source policy (includes Apply — the fix from #644)
    const sourcePolicy = {
      ...stalePolicy,
      writeOperationPrefixes: ['Create', 'Delete', 'Update', 'Apply'],
    };

    mkdirSync(join(tmpDir, 'safety'), { recursive: true });
    mkdirSync(join(tmpDir, 'source'), { recursive: true });
    writeFileSync(runtimePolicyPath, JSON.stringify(stalePolicy, null, 2));
    writeFileSync(sourcePolicyPath, JSON.stringify(sourcePolicy, null, 2));

    const result = syncPolicyFromSource({
      runtimePolicyPath,
      sourcePolicyPath,
      log: false,
    });

    assert.equal(result.synced, true);
    assert.equal(result.reason, 'synced');
    assert.match(result.diff, /\+Apply/);

    // Verify the runtime file was actually overwritten with the source content
    const synced = JSON.parse(readFileSync(runtimePolicyPath, 'utf8'));
    assert.deepEqual(synced, sourcePolicy);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncPolicyFromSource skips sync when hashes match (in sync)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'policy-sync-ok-'));
  try {
    const runtimePolicyPath = join(tmpDir, 'runtime', 'policy.json');
    const sourcePolicyPath = join(tmpDir, 'source', 'policy.json');
    const policy = {
      version: '0.1.0',
      writeOperationPrefixes: ['Create', 'Apply'],
      readOperationPrefixes: ['List'],
    };
    mkdirSync(join(tmpDir, 'runtime'), { recursive: true });
    mkdirSync(join(tmpDir, 'source'), { recursive: true });
    writeFileSync(runtimePolicyPath, JSON.stringify(policy));
    writeFileSync(sourcePolicyPath, JSON.stringify(policy));

    const result = syncPolicyFromSource({ runtimePolicyPath, sourcePolicyPath, log: false });
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'in_sync');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncPolicyFromSource returns source_not_found when no source path resolves', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'policy-nosrc-'));
  try {
    const runtimePolicyPath = join(tmpDir, 'runtime', 'policy.json');
    const missingSource = join(tmpDir, 'does-not-exist', 'policy.json');
    mkdirSync(join(tmpDir, 'runtime'), { recursive: true });
    writeFileSync(runtimePolicyPath, JSON.stringify({ writeOperationPrefixes: [] }));

    const result = syncPolicyFromSource({
      runtimePolicyPath,
      sourcePolicyPath: missingSource,
      log: false,
    });
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'source_not_found');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncPolicyFromSource handles missing runtime policy (first launch) by syncing', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'policy-firstrun-'));
  try {
    const runtimePolicyPath = join(tmpDir, 'safety', 'policy.json');
    const sourcePolicyPath = join(tmpDir, 'source', 'policy.json');
    const sourcePolicy = {
      version: '0.1.0',
      writeOperationPrefixes: ['Create', 'Apply'],
      readOperationPrefixes: ['List'],
    };
    mkdirSync(join(tmpDir, 'source'), { recursive: true });
    writeFileSync(sourcePolicyPath, JSON.stringify(sourcePolicy));

    const result = syncPolicyFromSource({
      runtimePolicyPath,
      sourcePolicyPath,
      log: false,
    });
    assert.equal(result.synced, true);
    assert.equal(result.reason, 'synced');
    const synced = JSON.parse(readFileSync(runtimePolicyPath, 'utf8'));
    assert.deepEqual(synced, sourcePolicy);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ApplyEip is denied as write with the current (synced) policy (#685 D4-5)', () => {
  // After auto-sync, the runtime policy must classify ApplyEip as deny/write.
  // The source policy.json already includes Apply in writeOperationPrefixes.
  const result = classifyHcloudArgs(['EIP', 'ApplyEip']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});
