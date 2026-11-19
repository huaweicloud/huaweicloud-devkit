import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateArtifacts,
  evaluateCommandRisk,
  evaluateDeployPlan,
  loadRiskRules,
} from '../plugins/huaweicloud-core/src/risk-rule-engine.ts';

test('loadRiskRules loads the public catalog', () => {
  const catalog = loadRiskRules();
  assert.equal(catalog.version, '0.1.0');
  assert.ok(catalog.rules.some((rule) => rule.id === 'hwc-network-public-admin-port'));
});

// #954 pair-change: GetCallerIdentity left the STS credential warn (it is a
// first-class read the devkit itself performs); the credential-returning pair
// keeps the warn. Pinned both directions so the alternation cannot drift.
test('STS credential warn covers the credential pair, not GetCallerIdentity (#954)', () => {
  const gci = evaluateCommandRisk('hcloud STS GetCallerIdentity --cli-region=cn-north-4');
  assert.equal(
    gci.findings.some((f) => f.ruleId === 'hwc-command-sts-credential'),
    false,
  );
  for (const cmd of [
    'hcloud STS AssumeAgency --agency_urn=<urn> --agency_session_name=<n> --duration_seconds=3600',
    'hcloud STS GetTemporaryCredential --cli-region=cn-north-4',
  ]) {
    const result = evaluateCommandRisk(cmd);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-command-sts-credential'),
      `${cmd} must carry the STS credential warn`,
    );
  }
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

// AX report N-R4.2: shell-transcribed commands carry escaped quotes
// (`\"Action\":`), the exact spelling the plan/advisory pipeline produces.
// The catalog's JSON-shaped rules must match that shadow spelling too — the
// escape must never demote a deny-severity rule to "not matched".
test('escaped JSON quotes do not defeat broad IAM policy detection (N-R4.2)', () => {
  const escaped = 'hcloud IAM CreatePolicy --policy.content={\\"Action\\":[\\"*\\"],\\"Effect\\":\\"Allow\\"}';
  const result = evaluateCommandRisk(escaped);
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-iam-admin-policy'));
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-iam-wildcard-action'));
  assert.equal(result.decision, 'deny');
});

test('escaped JSON quotes survive double escaping (N-R4.2)', () => {
  const doubleEscaped =
    'hcloud IAM CreatePolicy --policy.content={\\\\"Action\\\\":[\\\\"*\\\\"],\\\\"Effect\\\\":\\\\"Allow\\\\"}';
  const result = evaluateCommandRisk(doubleEscaped);
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-iam-admin-policy'));
});

test('escaped JSON artifacts keep the IAM deny (N-R4.2)', () => {
  const result = evaluateArtifacts([
    {
      path: 'policy.json',
      content: '{\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":[\\"*\\"]}]}',
    },
  ]);
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('escaped JSON quotes do not defeat OBS anonymous-write detection (N-R4.2)', () => {
  const result = evaluateCommandRisk(
    'hcloud OBS PutBucketPolicy --policy={\\"Statement\\":[{\\"Principal\\":\\"*\\",\\"Action\\":\\"PutObject\\"}]}',
  );
  assert.equal(result.decision, 'deny');
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-obs-anonymous-write'));
});

test('escaped JSON artifacts keep privileged-container detection (N-R4.2)', () => {
  const result = evaluateArtifacts([
    {
      path: 'deployment.json',
      content: '{\\"securityContext\\":{\\"privileged\\":true,\\"allowPrivilegeEscalation\\":true}}',
    },
  ]);
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-container-privileged'));
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-container-privilege-escalation'));
});

test('escaped JSON artifacts keep plaintext-password detection (N-R4.2)', () => {
  const result = evaluateArtifacts([{ path: 'settings.json', content: '{\\"db_password\\":\\"SuperSecret123\\"}' }]);
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-artifact-plaintext-password'));
});

test('rule normalization does not fold Windows path backslashes (N-R4.2)', () => {
  const result = evaluateCommandRisk('hcloud ECS ListServers --cli-region=cn-north-4 --path=C:\\tmp\\docs');
  assert.equal(result.findings.length, 0);
});

// AX N-R4.1: the secret-in-arg name table missed DEW's secret_text and the
// DevBridge api_key; both are plaintext credentials on the command line.
test('secret-in-arg covers secret_text and api_key parameter names (N-R4.1)', () => {
  const dew = evaluateCommandRisk('hcloud DEW CreateSecret --secret.secret_text=PlainTextSecret123');
  assert.ok(dew.findings.some((f) => f.ruleId === 'hwc-command-secret-in-arg'));
  for (const command of [
    'hcloud Foo --api_key=devbridge_abc123',
    'hcloud Foo --apiKey=devbridge_abc123',
    'hcloud Foo --secret_text=PlainText123',
  ]) {
    assert.ok(
      evaluateCommandRisk(command).findings.some((f) => f.ruleId === 'hwc-command-secret-in-arg'),
      `${command} must carry the plaintext-secret warn`,
    );
  }
});

test('artifact evidence redacts XML passwords and escaped JSON secrets (N-R4.1)', () => {
  const xml = evaluateArtifacts([
    {
      path: 'settings.xml',
      content: '<settings><servers><server><password>FakePassw0rd!xyz</password></server></servers></settings>',
    },
  ]);
  assert.ok(xml.findings.some((f) => f.ruleId === 'hwc-artifact-plaintext-password'));
  assert.doesNotMatch(xml.findings[0]!.evidence, /FakePassw0rd/);
  assert.match(xml.findings[0]!.evidence, /<redacted>/);

  const escaped = evaluateArtifacts([{ path: 'a.json', content: '{\\"db_password\\":\\"SuperSecret123\\"}' }]);
  for (const finding of escaped.findings) {
    assert.doesNotMatch(finding.evidence, /SuperSecret123/);
  }
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

test('evidence snippets redact admin-pass / admin_pass variants (#726 D4-27 v2)', () => {
  // redactEvidence now uses admin[_-]?pass to cover hyphen/underscore forms.
  const hyphen = evaluateCommandRisk(
    'hcloud ECS CreateServers --server.admin-pass=HyphenSecret123! --security_group_rule.remote_ip_prefix=0.0.0.0/0 --security_group_rule.port_range_min=22',
  );
  assert.equal(hyphen.decision, 'deny');
  assert.doesNotMatch(JSON.stringify(hyphen), /HyphenSecret123/);
  assert.match(JSON.stringify(hyphen), /<redacted>/);

  const underscore = evaluateCommandRisk(
    'hcloud ECS CreateServers --server.admin_pass=UnderSecret123! --security_group_rule.remote_ip_prefix=0.0.0.0/0 --security_group_rule.port_range_min=22',
  );
  assert.equal(underscore.decision, 'deny');
  assert.doesNotMatch(JSON.stringify(underscore), /UnderSecret123/);
  assert.match(JSON.stringify(underscore), /<redacted>/);
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

test('evaluateCommandRisk warns on high-risk IAM principal writes (#725)', () => {
  // The verb*noun family covers the IAM write surface the skill teaches,
  // including the V5/Keystone spellings and privilege-grant associates.
  const writes = [
    'CreateUser',
    'CreatePolicy',
    'CreateRole',
    'CreateAgency',
    'CreateGroupV5',
    'CreateCloudServiceCustomPolicy',
    'CreateLoginToken',
    'AttachGroupPolicyV5',
    'AttachUserPolicyV5',
    'AssociateAgencyWithDomainPermission',
    'UpdateUser',
    'KeystoneCreateUser',
  ];
  for (const op of writes) {
    const result = evaluateCommandRisk(`hcloud IAM ${op} --name admin`);
    assert.equal(result.decision, 'warn', `IAM ${op} should warn`);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-iam-highrisk-write'),
      `IAM ${op} should carry hwc-iam-highrisk-write`,
    );
  }
  // The Windows spelling stays covered too.
  const exe = evaluateCommandRisk('hcloud.exe IAM CreateUser --name admin');
  assert.ok(exe.findings.some((f) => f.ruleId === 'hwc-iam-highrisk-write'));
});

test('evaluateCommandRisk still allows IAM read-only operations (#725)', () => {
  for (const op of ['ListUsers', 'ShowUser', 'ListPolicies', 'ShowPolicy', 'KeystoneListUsers']) {
    const result = evaluateCommandRisk(`hcloud IAM ${op} --limit=1`);
    assert.equal(result.decision, 'allow', `IAM ${op} should be allowed`);
    assert.equal(result.findings.length, 0, `IAM ${op} should have no findings`);
  }
});

test('evaluateCommandRisk warns on plaintext secret in CLI args (#561 D4-3)', () => {
  const cases = [
    'hcloud ECS CreateServers --adminPass=SuperSecret123!',
    'hcloud ECS CreateServers --server.adminPass=SuperSecret123!',
    'hcloud ECS CreateServers --admin_pass=UnderSecret456!',
    'hcloud ECS CreateServers --admin-password=HyphenSecret789!',
    'hcloud RDS CreateInstance --password=DbPass456!',
    'hcloud RDS CreateInstance --db_user_password=DbPass456!',
    'hcloud ECS CreateServers --secret=mysecret',
    'hcloud ECS CreateServers --token=abc123',
    'hcloud IAM CreateLoginToken --ak=LTC4akia0000 --sk=skvalue0000',
    'hcloud configure set --cli-secret-key=LTC4sk0000',
  ];
  for (const cmd of cases) {
    const result = evaluateCommandRisk(cmd);
    assert.equal(result.decision, 'warn', `${cmd} should warn`);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-command-secret-in-arg'),
      `${cmd} should carry hwc-command-secret-in-arg`,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /SuperSecret123!|UnderSecret456!|HyphenSecret789!|DbPass456!|mysecret|abc123|LTC4akia0000|skvalue0000|LTC4sk0000/,
    );
  }
  // Placeholder values should not trigger the rule: unquoted and quoted
  // placeholder conventions are both exempt.
  assert.equal(evaluateCommandRisk('hcloud ECS CreateServers --adminPass=<password>').findings.length, 0);
  assert.equal(evaluateCommandRisk('hcloud ECS CreateServers --password="<password>"').findings.length, 0);
  // A closing quote right after the flag (grep patterns over docs) is not a value.
  assert.equal(evaluateCommandRisk('grep -rn "hcloud.*--password=" docs/').findings.length, 0);
  // Non-value parameters stay exempt.
  for (const cmd of [
    'hcloud CSMS ListSecrets --secret_name=prod/db',
    'hcloud ECS CreateServers --password_policy=strong',
    'hcloud ELB CreateListener --server.protocol=TCP',
  ]) {
    assert.equal(evaluateCommandRisk(cmd).findings.length, 0, cmd);
  }
});

test('evaluateCommandRisk blocks env dumps of generic credential keys (#1158 D4-2)', () => {
  for (const cmd of [
    'env | grep access_key',
    'env | grep secret_key',
    'printenv | grep ACCESS_KEY_ID',
    'env | grep api_key',
  ]) {
    const result = evaluateCommandRisk(cmd);
    assert.equal(result.decision, 'deny', `${cmd} should deny`);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-command-env-dump'),
      `${cmd} should carry hwc-command-env-dump`,
    );
  }
  assert.equal(evaluateCommandRisk('grep -rn access_key src/').decision, 'allow');
});

test('evaluateCommandRisk warns on --admin-pass / --admin_pass command forms (#1158 D4-6)', () => {
  for (const cmd of [
    'hcloud ECS CreateServers --admin-pass SuperSecret123!',
    'hcloud ECS CreateServers --admin_pass SuperSecret123!',
  ]) {
    const result = evaluateCommandRisk(cmd);
    assert.equal(result.decision, 'warn', `${cmd} should warn`);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-command-adminpass-exposure'),
      'adminpass rule must fire in the command stage',
    );
    assert.doesNotMatch(JSON.stringify(result), /SuperSecret123!/, 'evidence must be redacted');
  }
  assert.equal(evaluateCommandRisk('hcloud ECS CreateServers --admin-pass <password>').findings.length, 0);
});

test('evaluateArtifacts warns on admin_pass in Terraform files (#733 D4-6)', () => {
  const result = evaluateArtifacts([
    {
      path: 'terraform.tf',
      content: 'resource "huaweicloud_compute_instance" "web" {\n  admin_pass = "MyP@ssword1"\n}',
    },
  ]);
  assert.equal(result.decision, 'warn');
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-command-adminpass-exposure'));
  assert.doesNotMatch(JSON.stringify(result), /MyP@ssword1/);
});

test('evaluateArtifacts warns on adminPass and admin-password variants (#733 D4-6)', () => {
  for (const [variant, content] of [
    ['adminPass', 'resource "x" "y" {\n  adminPass = "Secret1"\n}'],
    ['admin-password', 'resource "x" "y" {\n  admin-password = "Secret2"\n}'],
  ] as const) {
    const result = evaluateArtifacts([{ path: 'main.tf', content }]);
    assert.equal(result.decision, 'warn', `${variant} should trigger adminpass rule`);
    assert.ok(result.findings.some((f) => f.ruleId === 'hwc-command-adminpass-exposure'));
    assert.doesNotMatch(JSON.stringify(result), /Secret1|Secret2/);
  }
});

test('evaluateDeployPlan warns when plan contains adminPass field (#733 D4-6)', () => {
  const result = evaluateDeployPlan({
    service: 'ECS',
    action: 'CreateServers',
    params: { adminPass: 'P@ssw0rd123!' },
  });
  assert.equal(result.decision, 'warn');
  assert.ok(result.findings.some((f) => f.ruleId === 'hwc-command-adminpass-exposure'));
  // The JSON-serialized plan is the evidence text — the quoted-key form must
  // redact like the CLI-arg form does.
  assert.doesNotMatch(JSON.stringify(result), /P@ssw0rd123/);
});

test('evidence redaction covers YAML prose keys, escaped JSON keys, AK/SK, and spares secret:// refs', () => {
  // YAML/prose `key: value` forms redact; the vault ref pattern survives.
  const yaml = evaluateArtifacts([
    {
      path: 'deploy.yaml',
      content: 'admin_pass: MyP@ss1\nsecret: hunter2\ntoken: abc\nref: secret://prod/db',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(yaml), /MyP@ss1|hunter2|"abc"/);
  assert.match(JSON.stringify(yaml), /secret:\/\/prod\/db/);
  // Keys JSON-stringified INSIDE a string value carry \" escapes.
  const nested = evaluateDeployPlan({
    service: 'ECS',
    action: 'CreateServers',
    params: { note: 'inline "password": pw9 and \\"passwd\\": pw8 end' },
  });
  assert.doesNotMatch(JSON.stringify(nested), /pw9|pw8/);
  // AK/SK spellings redact case-insensitively through quotes — including
  // keys escaped inside string values (\"AK\" / \\"SK\\" forms).
  const aksk = evaluateDeployPlan({
    service: 'ECS',
    action: 'CreateServers',
    params: {
      adminPass: 'Pw1',
      AK: 'LTC4AKIAAAAAAAAAAA',
      sk: 'sksecret00',
      note: 'cf \\"AK\\": \\"EscAk0000\\" and \\\\\\"SK\\\\\\": \\"EscSk0000\\" end',
    },
  });
  assert.doesNotMatch(JSON.stringify(aksk), /LTC4AKIAAAAAAAAAAA|sksecret00|EscAk0000|EscSk0000/);
});

test('the fork-bomb pattern matches real fork bombs without pathological backtracking', () => {
  // The rule was double-escaped (dead) and quadratically backtracking;
  // both are fixed. Pin the real bombs (spaced variants included) and the
  // adversarial shapes that used to stall the engine.
  for (const bomb of [':(){ :|:& };:', ':(){:|:&};:', ':(){ :|:& }; :', ': () { : | : & }; :']) {
    const result = evaluateCommandRisk(bomb);
    assert.equal(result.decision, 'deny', bomb);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-sandbox-destructive-command'),
      bomb,
    );
  }
  // Ambiguous-body and prefix-repeat shapes must stay linear, and all FOUR
  // bounded classes get an overrun pin. The {0,64} bounds trade recall for
  // linearity and the miss is real: FUNCTIONAL bombs padded past 64 chars
  // in any segment escape every layer (e.g. ':(){ :|:& ' + 100 chars +
  // '; };:' keeps the exponential core and passes bash -n), and so do
  // multi-pipe bodies at ANY length (':(){ :|:|:& };:' — the body classes
  // exclude | and & to stay linear). Deliberate-padding containment only —
  // accept the miss or revisit the bound.
  const amb = evaluateCommandRisk(':(){ |' + 'a&'.repeat(20000));
  assert.equal(amb.decision, 'allow');
  const repeat = evaluateCommandRisk(':(){'.repeat(20000));
  assert.equal(repeat.decision, 'allow');
  for (const padded of [
    ':(){ :|' + 'a'.repeat(100) + '& };:',
    ':(){ ' + 'a'.repeat(100) + '|:& };:',
    ':(){ :|:& }' + 'a'.repeat(100) + ';:',
    ':(){ :|:& ' + 'a'.repeat(100) + ' };:',
    ':(){ :|:& ' + 'a'.repeat(100) + '; };:',
    ':(){ :|:|:& };:',
  ]) {
    assert.equal(evaluateCommandRisk(padded).decision, 'allow', padded.slice(0, 20));
  }
});

test('the sandbox destructive rule anchors shutdown/reboot verbs at command position, not mentions', () => {
  // The reboot-parameter incident: bare \\breboot\\b matched the REQUIRED
  // --reboot.servers.[N].id / --reboot.type parameter names and denied an
  // approved `hcloud ECS BatchRebootServers` after confirmation. The
  // OS-verb arms now match the verb at a command position only (line
  // head, a ; & | $() boundary, or a bounded wrapper stack); the rm, dd,
  // and fork-bomb arms keep their original substring/bounded shapes.
  const denies = (cmd: string) => {
    const result = evaluateCommandRisk(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.ok(
      result.findings.some((f) => f.ruleId === 'hwc-sandbox-destructive-command'),
      cmd,
    );
  };
  const allows = (cmd: string) => {
    const result = evaluateCommandRisk(cmd);
    assert.equal(result.decision, 'allow', cmd);
  };

  for (const cmd of [
    'sudo reboot',
    'reboot',
    'shutdown -h now',
    'poweroff',
    'sudo halt',
    'halt',
    'telinit 6',
    'init 0',
    'sudo init 6',
    '/sbin/reboot',
    'sudo -u root reboot',
    'sudo -n reboot',
    'sudo -n systemctl reboot',
    'systemctl reboot',
    'systemctl --no-block reboot',
    'sudo systemctl poweroff',
    'systemctl halt',
    'nohup reboot &',
    'echo hi | xargs reboot',
    'watch reboot',
    'timeout 30 reboot',
    'busybox reboot',
    'cd /tmp && reboot',
    'echo a||poweroff',
    'setsid reboot',
    'foo;\n reboot',
    '$(reboot)',
    'bash -c "reboot"',
    'bash -ic "reboot"',
    "bash -e -c 'reboot'",
    'zsh -c "init 0"',
    'eval "poweroff"',
    'bash -c "echo hi; sudo reboot"',
    'sh -c "sudo -u root reboot"',
    'mkfs.ext4 /dev/vdb',
    'sudo mkfs.ext4 /dev/vdb',
    'fdisk /dev/sda',
    'sudo fdisk /dev/sda',
  ]) {
    denies(cmd);
  }

  // The incident argv and the mention classes stay allow at the rule level
  // (the argv face denies the unapproved form through the write gate, not
  // through this rule).
  for (const cmd of [
    'hcloud ECS BatchRebootServers --reboot.servers.1.id=i --reboot.type=SOFT',
    'grep -rn reboot docs/',
    'git log --grep=reboot',
    'echo "deploy after reboot"',
    'man reboot',
    'cat notes/reboot.md',
    'reboot.txt',
    'env reboot=false',
    'command -v reboot',
    'reboot-now --dry-run',
    'sudo -u reboot id',
    'sudo grep reboot docs/',
    'xargs -I{} echo reboot',
    'timeout reboot',
    'git init',
    'initdb',
    'nice -n 5 reboot',
    'halt-check.sh',
    'systemctl restart reboot-daemon',
    'docker exec ctr init 0',
    'bash -c "grep reboot /var/log"',
    'grep "(reboot)" crontab.txt',
    'grep "mkfs" docs/',
    'man mkfs',
    'cat mkfs-notes.md',
    'mkfs-helper --dry-run',
  ]) {
    allows(cmd);
  }

  // Deliberate over-deny faces, pinned so the trade stays a decision: the
  // sudo-anywhere arm keeps `ssh … "sudo reboot"` deniable, and the rm/dd
  // substring arms keep their mention catch (grep "dd if=" docs/ denies).
  denies('ssh -i k root@1.2.3.4 "sudo reboot"');
  denies('echo "sudo reboot done"');
  denies('grep "sudo reboot" runbook.md');
  denies('grep "dd if=" docs/');
});

test('the anchored arms stay linear under adversarial padding', () => {
  const deny = (cmd: string) => evaluateCommandRisk(cmd).decision;
  const t0 = () => Date.now();
  const bounded = (pad: string, build: () => string) => {
    const before = t0();
    deny(build());
    const elapsed = t0() - before;
    assert.ok(elapsed < 250, `${pad} took ${elapsed}ms — backtracking crept back in`);
  };
  bounded('sudo value-flag stack', () => 'sudo -u x '.repeat(2000) + 'reboot');
  bounded('sudo bare-flag stack', () => 'sudo -n '.repeat(5000) + 'reboot');
  bounded('carrier separator flood', () => 'bash -c "a;'.repeat(20000));
  bounded('env assignment stack', () => 'env A=b '.repeat(4000) + 'reboot');
  bounded('xargs flag stack', () => 'xargs -a '.repeat(5000) + 'reboot');
  bounded('command-substitution flood', () => '$('.repeat(3000));
  bounded('verb word flood', () => 'fdisk'.repeat(30000));
  bounded('systemctl option stack', () => 'systemctl --no-block '.repeat(3000) + 'reboot');
});

test('evaluateCommandRisk fails closed on malformed input (#564)', () => {
  for (const bad of [null, undefined, 12345, { cmd: 'x' }, '', '   ']) {
    const result = evaluateCommandRisk(bad);
    assert.equal(result.decision, 'deny', `input ${String(bad)} must deny`);
    assert.equal(result.risk, 'invalid');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'invalid-input');
    assert.match(result.findings[0].message, /non-empty string/);
  }
  // A long but well-formed string is not an anomaly — allow is the correct verdict.
  const long = evaluateCommandRisk('verylongcmd '.repeat(2000));
  assert.equal(long.decision, 'allow');
});

test('evaluateArtifacts fails closed on malformed input (#564)', () => {
  for (const bad of [null, undefined, [], {}, 'x']) {
    const result = evaluateArtifacts(bad);
    assert.equal(result.decision, 'deny', `input ${String(bad)} must deny`);
    assert.equal(result.risk, 'invalid');
    assert.equal(result.findings[0].ruleId, 'invalid-input');
  }
  assert.equal(evaluateArtifacts([{ path: 'a.json', content: '{}' }]).decision !== 'deny', true);
});

test('evaluateDeployPlan fails closed on malformed input (#564)', () => {
  for (const bad of [null, undefined, {}, [], 5, true, '', '   ']) {
    const result = evaluateDeployPlan(bad);
    assert.equal(result.decision, 'deny', `input ${JSON.stringify(bad)} must deny`);
    assert.equal(result.risk, 'invalid');
    assert.equal(result.findings[0].ruleId, 'invalid-input');
  }
  assert.equal(evaluateDeployPlan({ app: 'x' }).decision !== 'deny', true);
  assert.equal(evaluateDeployPlan('deploy a static site').decision !== 'deny', true);
});

// ── Artifact-stage gaps (2026-11-05 UX report #9) ───────────────────────────

test('evaluateArtifacts denies a hardcoded cloud credential in an artifact', () => {
  const result = evaluateArtifacts([
    {
      path: 'main.tf',
      content: 'resource "huaweicloud_compute_instance" "x" {\n  access_key = "leaked-example-key-42"\n}\n',
    },
  ]);
  assert.equal(result.decision, 'deny');
  const cred = result.findings.find((f) => f.ruleId === 'hwc-artifact-hardcoded-credential');
  assert.ok(cred, 'the hardcoded-credential rule must fire');
  assert.ok(!cred.evidence.includes('leaked-example-key-42'), 'the evidence must not echo the literal key');
});

test('evaluateArtifacts denies hardcoded credentials in JSON, unquoted, YAML, and escaped shapes (loop round 2 R3)', () => {
  // JSON is hook_check_artifacts' natural input shape: the key's closing
  // quote used to sit between the key and the colon and break the match,
  // while the same diff's redactEvidence tolerated it.
  // The literal is deliberately LOW-entropy (below the gitleaks
  // generic-api-key threshold) — the devkit rule fires on credential SHAPE,
  // not entropy, so a realistic-looking high-entropy fake here only gets
  // the file itself flagged by CI's secret scan (2026-11-09, 4 findings).
  const shapes: Array<[string, string]> = [
    ['config.json', '{"secret_key":"leaked-example-key-42"}'],
    ['config-escaped.json', '{\\"secret_key\\":\\"leaked-example-key-42\\"}'],
    // Shell profile: an unquoted export is a real leak shape.
    ['bashrc', 'export HW_ACCESS_KEY=leaked-example-key-42'],
    // YAML multiline: the value sits on the following line, unquoted.
    ['s.yaml', 'access_key:\n  leaked-example-key-42'],
    // deploy_plan's object form (the engine JSON.stringifies it).
    ['plan.json', '{\n  "access_key": "leaked-example-key-42"\n}'],
  ];
  for (const [path, content] of shapes) {
    const result = evaluateArtifacts([{ path, content }]);
    assert.ok(
      result.findings.map((f) => f.ruleId).includes('hwc-artifact-hardcoded-credential'),
      `${path} must trip the hardcoded-credential rule`,
    );
    assert.equal(result.decision, 'deny', `${path} must deny`);
    assert.ok(
      !result.findings.some((f) => f.evidence.includes('leaked-example-key-42')),
      `${path}: the evidence must not echo the literal key`,
    );
  }
});

test('evaluateArtifacts warns when a public CIDR hides its port behind a variable reference', () => {
  // The admin-port rule needs a literal port number; a var-referenced port
  // used to slip past every rule (the seat-4 J4 probe).
  const result = evaluateArtifacts([
    {
      path: 'sg.tf',
      content:
        'resource "huaweicloud_networking_secgroup_rule" "r" {\n  direction = "ingress"\n  remote_ip_prefix = "0.0.0.0/0"\n  port_range_min = var.ssh_port\n}\n',
    },
  ]);
  assert.equal(result.decision, 'warn');
  assert.ok(result.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'));
});

test('the variable-port rule fires on the JSON security-group shape too (loop round 2 R3)', () => {
  // remote_ip_prefix is the OpenStack/neutron field name: its native
  // serialization is JSON, where the key's closing quote broke the match.
  const result = evaluateArtifacts([
    {
      path: 'sg.json',
      content: '{"remote_ip_prefix": "0.0.0.0/0", "port_range_min": "${port}", "port_range_max": "${port}"}',
    },
  ]);
  assert.equal(result.decision, 'warn');
  assert.ok(result.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'));
});

test('placeholder-redacted credentials do not trip the hardcoded-credential rule', () => {
  const result = evaluateArtifacts([
    { path: 'main.tf', content: 'access_key = "<redacted>"\nremote_ip_prefix = "0.0.0.0/0"' },
  ]);
  assert.ok(
    !result.findings.map((f) => f.ruleId).includes('hwc-artifact-hardcoded-credential'),
    'a <redacted> placeholder is not a credential',
  );
});

test('var references and short values do not trip the hardcoded-credential rule', () => {
  for (const content of ['access_key = var.access_key\n', 'secret_key = "short"\n', 'access_key = ""\n']) {
    const result = evaluateArtifacts([{ path: 'x.tf', content }]);
    assert.ok(
      !result.findings.map((f) => f.ruleId).includes('hwc-artifact-hardcoded-credential'),
      `"${content.trim()}" is not a hardcoded credential`,
    );
  }
});

test('nested mapping keys and pure-letter words after a credential key stay allow (loop round 3 S4-B1)', () => {
  // `access_key:` followed by a nested mapping (description/placeholder as
  // the child KEY) is schema shape, not a hardcoded credential; pure-letter
  // English words (description/authentication) are not keys either — the
  // value must carry a digit to look like an AK/SK.
  const shapes: Array<[string, string]> = [
    ['schema.yaml', 'access_key:\n  description: The access key ID\n'],
    ['nested.json', '{"access_key": {"description": "x"}}'],
    ['docs.md', 'access_key: authentication\n'],
    ['ten-chars.txt', 'secret_key: abcdefghij\n'],
    ['prose.txt', 'your access_key: management here\n'],
  ];
  for (const [path, content] of shapes) {
    const result = evaluateArtifacts([{ path, content }]);
    assert.ok(
      !result.findings.map((f) => f.ruleId).includes('hwc-artifact-hardcoded-credential'),
      `${path} must not trip the credential rule`,
    );
  }
});

test('the variable-port rule warns on ANY non-literal port value behind a public CIDR (loop round 4 S4-B1)', () => {
  // The round-3 reference family was a closed enumeration — floor()/int()/
  // split()/jsondecode() slipped through wholesale. The round-5 form is the
  // NEGATIVE: a public CIDR plus a port key whose value is not a literal
  // number is un-confirmable, whatever wraps it.
  for (const ref of [
    'var.ssh_port',
    'local.ssh_port',
    'module.sg.ssh_port',
    'each.port',
    'data.aws_port.x',
    'toset(ports)',
    'lookup(var.ports, "ssh")',
    'floor(var.ssh_port)',
    'int(var.x)',
    'split(":", var.p)[1]',
    'jsondecode(var.cfg).port',
    'try(var.admin_port, var.default_port)',
    'element(var.ports, 0)',
    'coalesce(var.port_a, var.port_b)',
    'tonumber(var.port)',
    'nonsensitive(var.port)',
  ]) {
    const result = evaluateArtifacts([
      { path: 'sg.tf', content: `remote_ip_prefix = "0.0.0.0/0"\nport_range_min = ${ref}\n` },
    ]);
    assert.ok(
      result.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'),
      `the ${ref} reference must warn`,
    );
  }
  // Literal values are the admin-port rule's territory: a literal
  // non-admin port behind a public CIDR stays quiet, a literal admin port
  // denies (the admin-port message documents web/non-admin ports as allowed).
  const quiet = evaluateArtifacts([
    { path: 'sg.tf', content: 'remote_ip_prefix = "0.0.0.0/0"\nport_range_min = 443\n' },
  ]);
  assert.ok(
    !quiet.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'),
    'a literal non-admin port must not warn',
  );
  const denied = evaluateArtifacts([
    { path: 'sg.tf', content: 'remote_ip_prefix = "0.0.0.0/0"\nport_range_min = 22\n' },
  ]);
  assert.ok(denied.findings.map((f) => f.ruleId).includes('hwc-network-public-admin-port'));
  // Resource-reference ports (resource_type.name.attr) are un-confirmable
  // too (loop round 7, seat-4 B1), and a PRIVATE 10.x CIDR is not a public
  // exposure (loop round 7, seat-4 B2 — the bare-arm lookbehind).
  const resRef = evaluateArtifacts([
    {
      path: 'sg.tf',
      content: 'remote_ip_prefix = "0.0.0.0/0"\nport_range_min = huaweicloud_instance.web.admin_port\n',
    },
  ]);
  assert.ok(resRef.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'));
  const privNet = evaluateArtifacts([
    { path: 'sg.tf', content: 'remote_ip_prefix = "10.0.0.0/0"\nport_range_min = var.x\n' },
  ]);
  assert.equal(privNet.decision, 'allow', 'a private 10.x CIDR is not a public exposure');
  const privNetLiteral = evaluateArtifacts([
    { path: 'sg.tf', content: 'remote_ip_prefix = "10.0.0.0/0"\nport_range_min = 22\n' },
  ]);
  assert.equal(privNetLiteral.decision, 'allow', 'private 10.x + literal admin port is not PUBLIC exposure');
  // Number-led literals are the literal regime regardless of wrapper noise
  // (loop round 6: quoted-padded " 443 " stays quiet; hex 0x16 reads as a
  // number prefix — a documented approximation, HCL has no hex literals).
  for (const literal of ['" 443 "', '0x16', '2.2e1']) {
    const result = evaluateArtifacts([
      { path: 'sg.tf', content: `remote_ip_prefix = "0.0.0.0/0"\nport_range_min = ${literal}\n` },
    ]);
    assert.ok(
      !result.findings.map((f) => f.ruleId).includes('hwc-network-public-cidr-variable-port'),
      `the literal ${literal} must not warn`,
    );
  }
});

test('privileged containers deny, escalation warns, and explicit false stays quiet', () => {
  const yaml = evaluateArtifacts([{ path: 'deploy.yaml', content: 'securityContext:\n  privileged: true\n' }]);
  assert.equal(yaml.decision, 'deny');
  assert.ok(yaml.findings.some((finding) => finding.ruleId === 'hwc-container-privileged'));

  const json = evaluateArtifacts([{ path: 'deploy.json', content: '{"securityContext":{"privileged":true}}' }]);
  assert.equal(json.decision, 'deny', 'quoted JSON keys match too');

  const off = evaluateArtifacts([{ path: 'deploy.yaml', content: 'privileged: false\n' }]);
  assert.equal(off.decision, 'allow');

  const escalation = evaluateArtifacts([{ path: 'deploy.yaml', content: 'allowPrivilegeEscalation: true\n' }]);
  assert.equal(escalation.decision, 'warn');
  assert.ok(escalation.findings.some((finding) => finding.ruleId === 'hwc-container-privilege-escalation'));
});

test('plaintext passwords warn in XML and key-value shapes, placeholders stay quiet', () => {
  const xml = evaluateArtifacts([{ path: 'settings.xml', content: '<password>Hunter2Plain</password>' }]);
  assert.equal(xml.decision, 'warn');
  assert.ok(xml.findings.some((finding) => finding.ruleId === 'hwc-artifact-plaintext-password'));

  const kv = evaluateDeployPlan({ env: { DB_PASSWORD: 'Hunter2Plain' } });
  assert.ok(kv.findings.some((finding) => finding.ruleId === 'hwc-artifact-plaintext-password'));

  for (const content of [
    '<password>${env.PASSWORD}</password>',
    '<password>******</password>',
    'password: var.db_password',
    'password: secret://user/db',
    'password_policy: strong',
  ]) {
    const result = evaluateArtifacts([{ path: 'artifact', content }]);
    assert.ok(
      !result.findings.some((finding) => finding.ruleId === 'hwc-artifact-plaintext-password'),
      `placeholder shape must stay quiet: ${content}`,
    );
  }
});

test('wildcard IAM actions are caught in Terraform, plural, and no-Effect shapes', () => {
  const terraform = evaluateArtifacts([
    { path: 'iam.tf', content: 'policy = "x"\neffect = "Allow"\nactions = ["*"]\n' },
  ]);
  assert.equal(terraform.decision, 'deny');
  assert.ok(terraform.findings.some((finding) => finding.ruleId === 'hwc-iam-admin-policy'));

  const noEffect = evaluateDeployPlan({ iam: { actions: ['*'] } });
  assert.equal(noEffect.decision, 'warn');
  assert.ok(noEffect.findings.some((finding) => finding.ruleId === 'hwc-iam-wildcard-action'));

  const narrow = evaluateArtifacts([
    { path: 'iam.tf', content: 'policy = "x"\neffect = "Allow"\nactions = ["vpc:subnets:get"]\n' },
  ]);
  assert.ok(
    !narrow.findings.some(
      (finding) => finding.ruleId === 'hwc-iam-admin-policy' || finding.ruleId === 'hwc-iam-wildcard-action',
    ),
  );
});
