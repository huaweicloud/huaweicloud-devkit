import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  isSecretKeyName,
  loadPolicy,
  redactSecrets,
  redactString,
} from '../plugins/huaweicloud-core/src/safety-policy.mjs';

const DEFAULT_POLICY = loadPolicy();

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

// --- #791: redactSecrets/redactString refactoring tests ---

test('#791 isSecretKeyName recognizes bare "token" as a secret key', () => {
  assert.equal(isSecretKeyName('token'), true);
  assert.equal(isSecretKeyName('Token'), true);
  assert.equal(isSecretKeyName('TOKEN'), true);
});

test('#791 isSecretKeyName does not match compound words like "tokenizer"', () => {
  assert.equal(isSecretKeyName('tokenizer'), false);
  assert.equal(isSecretKeyName('tokenCounter'), false);
});

test('#791 isSecretKeyName handles camelCase and dotted key names', () => {
  assert.equal(isSecretKeyName('--server.adminPass'), true);
  assert.equal(isSecretKeyName('secretAccessKey'), true);
  assert.equal(isSecretKeyName('db_password'), true);
  assert.equal(isSecretKeyName('normal_field'), false);
});

test('#791 redactString derives key names from policy, not hardcoded regex', () => {
  const customPolicy = {
    ...DEFAULT_POLICY,
    secretKeyNamePatterns: ['mycustomsecret', 'user[_-]?data'],
  };
  // Custom key from policy gets redacted — proves patterns are derived, not hardcoded.
  const out = redactString('mycustomsecret=value123\nnormal=output', customPolicy);
  assert.match(out, /mycustomsecret=<redacted>/);
  assert.doesNotMatch(out, /value123/);
  assert.match(out, /normal=output/);
  // Standard hardcoded keys are NOT present when policy doesn't list them.
  const out2 = redactString('password=secret123', customPolicy);
  assert.doesNotMatch(out2, /<redacted>/);
  assert.match(out2, /secret123/);
});

test('#791 redactString uses unified separator handling for : and =', () => {
  // Both colon and equals separators preserve the original delimiter.
  const colonOut = redactString('password: mysecret');
  assert.match(colonOut, /password: <redacted>/);
  assert.doesNotMatch(colonOut, /mysecret/);

  const eqOut = redactString('password=mysecret');
  assert.match(eqOut, /password=<redacted>/);
  assert.doesNotMatch(eqOut, /mysecret/);
});

test('#791 redactString word boundary prevents false positives in compound words', () => {
  // 'ak' inside 'break' must not trigger redaction.
  const out = redactString('break=foo\nflake=bar');
  assert.doesNotMatch(out, /<redacted>/);
  assert.match(out, /break=foo/);
  assert.match(out, /flake=bar/);
  // But 'ak' as a standalone key IS redacted.
  const out2 = redactString('ak=AKID123\nsk=SKSECRET');
  assert.match(out2, /ak=<redacted>/);
  assert.match(out2, /sk=<redacted>/);
  assert.doesNotMatch(out2, /AKID123|SKSECRET/);
});

test('#791 redactSecrets JSON string path reuses object redaction via isSecretKeyName', () => {
  // JSON object string → parse → object redaction → stringify.
  const jsonOut = redactSecrets('{"password":"secret123","normal":"visible"}');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.password, '<redacted>');
  assert.equal(parsed.normal, 'visible');

  // JSON with bare "token" key (previously required hardcoded regex).
  const tokenOut = redactSecrets('{"token":"abc-xyz-123"}');
  assert.equal(JSON.parse(tokenOut).token, '<redacted>');
});

test('#791 redactSecrets JSON array string path reuses object redaction', () => {
  const arrOut = redactSecrets('[{"secret_key":"sk-xxx"},{"name":"keep"}]');
  const parsed = JSON.parse(arrOut);
  assert.equal(parsed[0].secret_key, '<redacted>');
  assert.equal(parsed[1].name, 'keep');
});

test('#791 redactSecrets nested JSON string path recurses correctly', () => {
  const nestedOut = redactSecrets('{"outer":{"password":"deep-secret","visible":"ok"}}');
  const parsed = JSON.parse(nestedOut);
  assert.equal(parsed.outer.password, '<redacted>');
  assert.equal(parsed.outer.visible, 'ok');
});

test('#791 redactSecrets JSON parse failure falls back to redactString', () => {
  // Starts with { but is not valid JSON → fallback to regex-based redactString.
  const out = redactSecrets('{invalid json password=secret123}');
  assert.match(out, /<redacted>/);
  assert.doesNotMatch(out, /secret123/);
});

test('#791 redactSecrets non-JSON string still uses redactString', () => {
  // Does not start with { or [ → straight to redactString.
  const out = redactSecrets('log: password=hunter2 token=abc normal=text');
  assert.match(out, /password=<redacted>/);
  assert.match(out, /token=<redacted>/);
  assert.match(out, /normal=text/);
  assert.doesNotMatch(out, /hunter2|abc/);
});

test('#791 redactSecrets object path unchanged (regression guard)', () => {
  const redacted = redactSecrets({
    access_key: 'example-access-key',
    token: 'bare-token-value',
    nested: { secretAccessKey: 'example-secret-key', normal: 'visible' },
  });
  assert.equal(redacted.access_key, '<redacted>');
  assert.equal(redacted.token, '<redacted>');
  assert.equal(redacted.nested.secretAccessKey, '<redacted>');
  assert.equal(redacted.nested.normal, 'visible');
});

// --- #791: PR #772 regression scenarios ---

test('#791 redactSecrets redacts lowercase ak=/sk= patterns (#694 D2-4)', () => {
  const out = redactSecrets('ak=AK123456 sk=SKsecret');
  assert.doesNotMatch(out, /AK123456/);
  assert.doesNotMatch(out, /SKsecret/);
  assert.match(out, /ak=<redacted>/);
  assert.match(out, /sk=<redacted>/);
});

test('#791 redactSecrets redacts mixed-case Ak=/sK= patterns', () => {
  const out = redactSecrets('Ak=AK123456 sK=SKsecret');
  assert.doesNotMatch(out, /AK123456/);
  assert.doesNotMatch(out, /SKsecret/);
  assert.match(out, /Ak=<redacted>/);
  assert.match(out, /sK=<redacted>/);
});

test('#791 redactSecrets redacts uppercase AK=/SK= patterns (regression)', () => {
  const out = redactSecrets('AK=HPUAI12345\nSK=abcdef');
  assert.doesNotMatch(out, /HPUAI12345/);
  assert.doesNotMatch(out, /abcdef/);
  assert.match(out, /AK=<redacted>/);
  assert.match(out, /SK=<redacted>/);
});

test('#791 redactSecrets preserves separator (colon) for ak/sk', () => {
  const out = redactSecrets('ak:value sk:value');
  assert.match(out, /ak:<redacted>/);
  assert.match(out, /sk:<redacted>/);
  assert.doesNotMatch(out, /ak=<redacted>/);
});

test('#791 redactSecrets does not falsely redact words ending in ak/sk', () => {
  const safe = ['task=abc', 'mask=hello', 'leak=xxx', 'risk=high', 'break=stop', 'flask=hi', 'desk=top'];
  for (const input of safe) {
    const out = redactSecrets(input);
    assert.doesNotMatch(out, /<redacted>/, `${input} should not be redacted`);
  }
});

test('#791 redactSecrets redacts JSON-format quoted "ak":/"sk": keys (#694 original)', () => {
  const out = redactSecrets('{"ak": "AKIDTEST", "sk": "SKTEST"}');
  assert.doesNotMatch(out, /AKIDTEST/);
  assert.doesNotMatch(out, /SKTEST/);
  assert.match(out, /"ak":\s*"<redacted>"/);
  assert.match(out, /"sk":\s*"<redacted>"/);
});

test('#791 redactSecrets redacts JSON-format quoted "token" key', () => {
  const out = redactSecrets('{"token": "abc123"}');
  assert.doesNotMatch(out, /abc123/);
  assert.match(out, /"<redacted>"/);
});

// --- #791: hcloud-probe call site behavior ---

test('#791 redactSecrets handles hcloud-probe stdout JSON with secrets', () => {
  // Simulates hcloud-probe.mjs:126 calling redactSecrets(stdout) with JSON output
  const stdout = JSON.stringify({
    ak: 'AKIDTEST',
    sk: 'SKTEST',
    token: 'abc123',
    region: 'cn-north-4',
  });
  const redacted = redactSecrets(stdout);
  assert.doesNotMatch(redacted, /AKIDTEST/);
  assert.doesNotMatch(redacted, /SKTEST/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.match(redacted, /cn-north-4/);
});

test('#791 redactSecrets handles plain text hcloud-probe output without JSON', () => {
  const stdout = 'KooCLI version: 7.2.12\nak=AKIDTEST sk=SKTEST';
  const redacted = redactSecrets(stdout);
  assert.doesNotMatch(redacted, /AKIDTEST/);
  assert.doesNotMatch(redacted, /SKTEST/);
  assert.match(redacted, /7\.2\.12/);
});

// --- #791: object/string path consistency ---

test('#791 token is redacted consistently in object and string paths', () => {
  assert.equal(redactSecrets({ token: 'abc' }).token, '<redacted>');
  assert.match(redactSecrets('token=abc'), /token=<redacted>/);
  const jsonOut = redactSecrets('{"token": "abc"}');
  assert.doesNotMatch(jsonOut, /abc/);
});

test('#791 redactSecrets preserves original separator (: or =) uniformly', () => {
  assert.match(redactSecrets('password=secret'), /password=<redacted>/);
  assert.match(redactSecrets('password:secret'), /password:<redacted>/);
  assert.match(redactSecrets('ak=AKID'), /ak=<redacted>/);
  assert.match(redactSecrets('ak:AKID'), /ak:<redacted>/);
});

test('#791 redactSecrets redacts all policy-defined key names in key=value format', () => {
  const cases = [
    'access_key=AKID',
    'secret_key=SKID',
    'security_token=TOK',
    'x_auth_token=TOK',
    'authorization=Bearer xyz',
    'password=pass',
    'passwd=pass',
    'adminPass=pass',
    'admin_pass=pass',
    'credential=cred',
    'private_key=-----BEGIN',
    'token=tok',
  ];
  for (const input of cases) {
    const out = redactSecrets(input);
    assert.match(out, /<redacted>/, `${input} should be redacted`);
  }
});
