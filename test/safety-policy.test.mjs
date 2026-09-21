import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  redactSecrets,
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

test('redactSecrets redacts lowercase ak=/sk= patterns (#694 D2-4)', () => {
  // obsutilconfig uses lowercase ak=/sk= format — must be redacted.
  const out = redactSecrets('ak=AK123456 sk=SKsecret');
  assert.doesNotMatch(out, /AK123456/);
  assert.doesNotMatch(out, /SKsecret/);
  assert.match(out, /ak=<redacted>/);
  assert.match(out, /sk=<redacted>/);
});

test('redactSecrets redacts mixed-case Ak=/sK= patterns (#694 D2-4)', () => {
  const out = redactSecrets('Ak=MyAccessKey sK=MySecretKey');
  assert.doesNotMatch(out, /MyAccessKey/);
  assert.doesNotMatch(out, /MySecretKey/);
});

test('redactSecrets does not falsely redact access_key= or tokenize= (#694 D2-4)', () => {
  // access_key= is handled by the earlier generic credential regex, not the AK/SK one.
  // tokenize= must not be matched by the AK/SK pattern.
  const out1 = redactSecrets('access_key=AKIDTEST');
  assert.doesNotMatch(out1, /AKIDTEST/);
  assert.match(out1, /access_key=<redacted>/);

  const out2 = redactSecrets('tokenize=abc');
  assert.equal(out2, 'tokenize=abc');
});

test('redactSecrets does not falsely redact words ending in ak/sk (#694 D2-4)', () => {
  // \b word boundary ensures AK/SK only matches as a standalone token, not as a
  // substring of words like task, mask, leak, risk, break, flask, desk.
  const words = ['task=abc', 'mask=hello', 'leak=xxx', 'risk=high', 'break=stop', 'flask=app', 'desk=clean'];
  for (const input of words) {
    const out = redactSecrets(input);
    assert.equal(out, input, `${input} should not be redacted`);
  }
});

test('redactSecrets redacts JSON-format quoted "ak":/"sk": keys (#694 D2-4)', () => {
  // hcloud-probe.mjs:126 calls redactSecrets(stdout) directly — without
  // redactOutput's JSON.parse path — so raw JSON ak/sk values must be redacted
  // at the string level. This is the original Issue #694 assertion.
  const out = redactSecrets('{"ak": "AKIDTEST", "sk": "SKTEST"}');
  assert.doesNotMatch(out, /AKIDTEST/);
  assert.doesNotMatch(out, /SKTEST/);
  assert.match(out, /"ak": "<redacted>"/);
  assert.match(out, /"sk": "<redacted>"/);
});

test('redactSecrets redacts JSON-format quoted "token" key (#694)', () => {
  // JSON short-key "token" must be redacted alongside "ak"/"sk" — a bare
  // "token": "value" pair in stdout must not leak the secret value (#694).
  const out = redactSecrets('{"token": "abc123"}');
  assert.doesNotMatch(out, /abc123/);
  assert.match(out, /"token": "<redacted>"/);
});


test('redactSecrets redacts lowercase ak:/sk: colon-separated patterns (#694 D2-4)', () => {
  // Colon separator must be preserved (not rewritten to =).
  const out = redactSecrets('ak:mykey sk:mysecret');
  assert.doesNotMatch(out, /mykey/);
  assert.doesNotMatch(out, /mysecret/);
  assert.match(out, /ak:<redacted>/);
  assert.match(out, /sk:<redacted>/);
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
