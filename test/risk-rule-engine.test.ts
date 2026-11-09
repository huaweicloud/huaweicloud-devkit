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
