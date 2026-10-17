import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

test('loadPolicy fails closed on a malformed policy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    const write = (content: string) => writeFileSync(join(dir, 'policy.json'), content);
    const expectThrow = (content: string, fragment: string) => {
      write(content);
      assert.throws(() => loadPolicy(join(dir, 'policy.json')), /TypeError/, fragment);
    };
    expectThrow('[]', 'array root');
    expectThrow('null', 'null root');
    expectThrow('{"writeOperationPrefixes": "list-vpcs"}', 'non-array field');
    expectThrow('{"secretKeyNamePatterns": null}', 'null field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPolicy accepts absent fields and the shipped policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    writeFileSync(join(dir, 'policy.json'), '{"writeOperationPrefixes": ["List"]}');
    const partial = loadPolicy(join(dir, 'policy.json'));
    assert.deepEqual(partial.writeOperationPrefixes, ['List']);
    assert.deepEqual(partial.secretKeyNamePatterns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const shipped = loadPolicy();
  assert.ok(shipped.writeOperationPrefixes.length > 0, 'shipped policy keeps write prefixes');
});

test('redactSecrets removes credential-shaped values recursively', () => {
  const redacted = redactSecrets({
    profile: 'dev',
    access_key: 'example-access-key',
    nested: {
      secretAccessKey: 'example-secret-key',
      normal: 'visible',
    },
  }) as {
    profile: string;
    access_key: string;
    nested: { secretAccessKey: string; normal: string };
  };
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
  }) as { '--server.adminPass': string; password: string; normal_field: string };
  assert.equal(redacted['--server.adminPass'], '<redacted>');
  assert.equal(redacted.password, '<redacted>');
  assert.equal(redacted.normal_field, 'keep');
});

test('redactSecrets handles array values', () => {
  const redacted = redactSecrets([
    { name: 'prod', secret_key: 'sk-xxx' },
    { name: 'dev', normal: 'value' },
  ]) as { name: string; secret_key: string; normal: string }[];
  assert.equal(redacted[0].secret_key, '<redacted>');
  assert.equal(redacted[1].normal, 'value');
});

test('redactSecrets handles string values with key=value patterns', () => {
  const out = redactSecrets('AK=HPUAI12345\nSK=abcdef\nnormal output');
  assert.match(out, /<redacted>/);
  assert.match(out, /normal output/);
  assert.doesNotMatch(out, /HPUAI12345/);
});

test('redactSecrets redacts bare token= values (#726 D4-27)', () => {
  const out = redactSecrets('token=TokenValueABCDEF123456');
  assert.equal(out, 'token=<redacted>');
  assert.doesNotMatch(out, /TokenValueABCDEF123456/);
  // Long secret-token keys still redact (no regression, longest-match first).
  assert.equal(redactSecrets('security_token=stABC123'), 'security_token=<redacted>');
  assert.equal(redactSecrets('x_auth_token=xatABC123'), 'x_auth_token=<redacted>');
  // Other secret keywords keep working alongside bare token.
  assert.equal(
    redactSecrets('token=t1\npassword=pw1\nadminPass=ap1\naccess_key=ak1'),
    'token=<redacted>\npassword=<redacted>\nadminPass=<redacted>\naccess_key=<redacted>',
  );
  // Non-secret tokens (e.g. tokenize=) must NOT be redacted — the '=' boundary
  // ensures 'token' is followed by '=' directly, not by 'ize'.
  assert.equal(redactSecrets('tokenize=abc\ntokenizer=xyz'), 'tokenize=abc\ntokenizer=xyz');
});

test('redactSecrets redacts admin-pass / admin_pass / adminPass variants (#726 D4-27 v2)', () => {
  // String path: redactString regex now uses admin[_-]?pass to cover all three
  // shapes (camelCase / hyphen / underscore) under the /i flag.
  assert.equal(redactSecrets('adminPass=Secret123!'), 'adminPass=<redacted>');
  assert.equal(redactSecrets('admin-pass=Secret123!'), 'admin-pass=<redacted>');
  assert.equal(redactSecrets('admin_pass=Secret123!'), 'admin_pass=<redacted>');
  assert.equal(redactSecrets('ADMIN-PASS=Secret123!'), 'ADMIN-PASS=<redacted>');
  assert.equal(redactSecrets('Admin_Pass=Secret123!'), 'Admin_Pass=<redacted>');
  // admin-password also redacts (password keyword catches it) — regression guard.
  assert.equal(redactSecrets('admin-password=Secret123!'), 'admin-password=<redacted>');
  // Object key path: isSecretKeyName normalizes separators, so all variants
  // are already secret-classified — regression guard.
  const obj = redactSecrets({
    adminPass: 'v1',
    'admin-pass': 'v2',
    admin_pass: 'v3',
  }) as { adminPass: string; 'admin-pass': string; admin_pass: string };
  assert.equal(obj.adminPass, '<redacted>');
  assert.equal(obj['admin-pass'], '<redacted>');
  assert.equal(obj.admin_pass, '<redacted>');
});

test('redactSecrets masks opaque blob keys (user_data / metadata / private_key) entirely', () => {
  const redacted = redactSecrets([
    'ECS',
    'CreateServers',
    '--server.user_data=ZXhwb3J0IEFQUF9TRUNSRVQ9czNjcjN0',
    '--server.user_data=echo TOKEN=abc123 >> /etc/x',
    '--server.metadata.db_password=secret123',
    '--keypair.private_key=-----BEGIN RSA PRIVATE KEY-----',
  ]) as string[];
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
  assert.match(result.reason ?? '', /credential|profile|secret/i);
});

test('classifyTextCommand blocks env var dumps with HUAWEICLOUD prefix', () => {
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
  assert.equal(classifyTextCommand('printenv | grep HWC_').decision, 'deny');
  assert.equal(classifyTextCommand('Get-ChildItem Env: | where HCLOUD_PROFILE').decision, 'deny');
});

test('classifyHcloudArgs blocks secret value reads', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecretVersion', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /secret value/i);
});

test('classifyHcloudArgs blocks unapproved writes', () => {
  const result = classifyHcloudArgs(['ECS', 'NovaCreateServers', '--body', '{}']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /write operation/i);
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
  assert.equal(result.findings?.[0].ruleId, 'hwc-network-public-admin-port');
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

test('existing credential and secret blocks still win before risk-rule warnings', () => {
  const credentialResult = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(credentialResult.decision, 'deny');
  assert.equal(credentialResult.risk, 'credential');
  assert.equal(Object.hasOwn(credentialResult, 'findings'), false);

  const secretResult = classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name prod/db');
  assert.equal(secretResult.decision, 'deny');
  assert.equal(secretResult.risk, 'secret');
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
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret rm secret://user/ak').decision, 'allow');
});

test('secret exec does not launder hcloud write classification', () => {
  const write = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS CreateServers --cli-region=cn-north-4',
  );
  assert.equal(write.decision, 'deny');
  assert.match(write.reason ?? '', /write/i);
  const read = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
  );
  assert.equal(read.decision, 'allow');
});

test('the vault store directory and master keyfile are credential files', () => {
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/user/hw-sk.json').decision, 'deny');
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/.master-key').decision, 'deny');
});

test('the vault reveal deny survives adversarial spellings (quotes, versions, source form)', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret "get" secret://user/hw-sk',
    'npx huaweicloud-devkit@latest secret get secret://user/hw-sk --stdout',
    'npx huaweicloud-devkit@2.3.0 secret get secret://user/hw-sk',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret get secret://user/hw-sk --stdout',
    'node dist/setup-cli.mjs secret get secret://user/hw-sk',
    './node_modules/.bin/huaweicloud-devkit.exe secret get secret://user/hw-sk',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives adversarial spellings (version specs, shells, segments)', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit@2.3.0 secret exec --env K=x -- bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"',
    "npx huaweicloud-devkit secret exec --env K=x -- bash -c 'hcloud ECS DeleteServers --cli-region=cn-north-4'",
    'echo hello && npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers --cli-region=cn-north-4',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret exec -- hcloud ECS NovaCreateServers',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
  // Reads through the wrapper stay allowed — the gate is the write, not the wrapper.
  assert.equal(
    classifyTextCommand(
      'npx huaweicloud-devkit@latest secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
    ).decision,
    'allow',
  );
});

test('quote-adjacent hcloud keeps its classification in plain shell too', () => {
  // Pre-existing gap closed alongside the exec unwrap: the presence gate ran
  // on raw text, so `bash -c "hcloud ..."` never routed into the classifier.
  const result = classifyTextCommand('bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"');
  assert.equal(result.decision, 'deny');
  // A quoted hcloud mention that is not a command stays allowed.
  assert.equal(classifyTextCommand('echo "hcloud rocks"').decision, 'allow');
});

test('the reveal deny survives ANSI-C quoting, expansion quotes, and multi-invocation lines', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret $"get" secret://user/hw-sk --stdout',
    "npx huaweicloud-devkit sec$'r'et get secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret g"e"t secret://user/hw-sk --stdout',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives earlier devkit invocations and npm separators', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers --cli-region=x"',
    'npx huaweicloud-devkit --version && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS DeleteServers"',
    'npx -- huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS CreateServers"',
    'npm exec huaweicloud-devkit -- secret exec --env K=x -- bash -c "hcloud ECS DeleteServers"',
    'node dist/setup-cli.mjs secret exec -- bash -c "hcloud ECS DeleteServers"',
    'secret list | npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers',
    // No devkit involvement: a non-leading shell-wrapped segment must classify too.
    'echo hi && bash -c "hcloud ECS CreateServers --cli-region=x"',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
});

test('quote-blind credential gates: env dumps and printenv through quoted command names', () => {
  assert.equal(classifyTextCommand('bash -c "env | grep HUAWEICLOUD"').decision, 'deny');
  assert.equal(classifyTextCommand("bash -c 'printenv HW_SECRET_KEY'").decision, 'deny');
  // Mid-token quotes must not hide a write operation from the write gate.
  assert.equal(classifyTextCommand("hcloud ECS Cre'ateServers --cli-region=x").decision, 'deny');
  // Single-quoted $HW_* stays exempt (the shell never expands it) — raw-text
  // lookbehind is deliberate.
  assert.equal(classifyTextCommand("echo '$HW_SECRET_KEY is a literal'").decision, 'allow');
});

test('the write gate classifies every line and command position of a payload', () => {
  const denyCases = [
    'hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x',
    'echo hello\nhcloud ECS CreateServers --server.name=x',
    'hcloud ECS ListServers & hcloud ECS DeleteServers',
    'for i in 1 2 3; do hcloud ECS DeleteServers --server.id=$i; done',
    'echo i-123 | xargs hcloud ECS DeleteServers --server.id=x',
    'env HW_REGION=cn-north-4 hcloud ECS DeleteServers --server.id=x',
    'nohup hcloud ECS DeleteServers --server.id=x',
    '/usr/bin/hcloud ECS DeleteServers',
    './hcloud ECS DeleteServers',
    'echo $(hcloud ECS DeleteServers)',
    'echo `hcloud ECS DeleteServers`',
    "hclou'd' ECS DeleteServers",
    'h\\cloud ECS DeleteServers',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  // Command-position env prefix stays legitimate; prose and filenames do
  // not fire the env-dump family.
  const allowCases = [
    'env -i hcloud ECS ListServers',
    'cat environment.md | grep nothing',
    'python3 env_setup.py --region cn-north-4 HUAWEICLOUD',
    'npx huaweicloud-devkit secret set secret://user/ak --file /tmp/key.txt',
  ];
  for (const command of allowCases) {
    assert.equal(classifyTextCommand(command).decision, 'allow', command);
  }
});

test('credential-file reads stay denied through quoted path spellings', () => {
  assert.equal(classifyTextCommand("cat ~/.config/huawei'cloud/secrets'/.master-key").decision, 'deny');
  assert.equal(classifyTextCommand('strings ~/.config/huawei"cloud"/secrets/x.json').decision, 'deny');
});

test('the reveal deny survives npm separators; ANSI-C escape obfuscation is denied outright', () => {
  assert.equal(
    classifyTextCommand('npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  // Escape-sequence ANSI-C builds argv the shadow cannot reconstruct — deny
  // the obfuscated invocation instead of parsing it.
  const obfuscated = 'npx huaweicloud-devkit secret $' + "'\\x67et' secret://user/hw-sk --stdout";
  const result = classifyTextCommand(obfuscated);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /obfuscated/i);
});

test('the env-dump family closes the full-dump and pipe-grep forms', () => {
  const denyCases = [
    'env',
    'printenv',
    'env -0',
    'export -p | grep HW_',
    'env | grep HW_ACCESS_KEY',
    'printenv PATH HW_SECRET_KEY',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  assert.equal(classifyTextCommand('printenv PATH').decision, 'allow');
});
