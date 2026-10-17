import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool, TOOL_DEFINITIONS, listSkillDirs, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';
import { runVersionCheck } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';
import { getToolSchema, TOOL_SCHEMAS } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import {
  clearRuntimeCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.ts';
import type { RiskFinding } from '../plugins/huaweicloud-core/src/risk-rule-engine.ts';
import { fixtureDir } from './fixture-dir.ts';

interface HookCheckResult {
  ok: boolean;
  decision: 'allow' | 'warn' | 'deny';
  findings: RiskFinding[];
}

interface ServiceCatalogResult {
  recommendedSkills: string[];
}

interface RetrieveSkillResult {
  ok: boolean;
  error?: string;
  name?: string;
  version?: string | number;
  description?: string;
  content?: string;
  references: Array<{ filename: string; content: string }>;
}

interface AuthSwitchResult {
  status: string;
  scope?: string;
  error?: string;
}

test('runVersionCheck uses hcloud version instead of --version', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ version: "7.0.0", args: process.argv.slice(2) }));', 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.match(result.output, /"version":\s*"7\.0\.0"/);
  assert.doesNotMatch(result.output, /--version/);
});

test('runVersionCheck returns installed:false and errorCode on ENOENT', async () => {
  const result = await runVersionCheck({ executable: 'nonexistent-hcloud-xyz' });
  assert.equal(result.installed, false);
  assert.equal(result.errorCode, 'HCLOUD_NOT_FOUND');
  assert.match(result.nextStep, /HCLOUD_BIN/);
});

test('runVersionCheck reports versionMismatch when installed version differs from kooCliVersion', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ version: "7.0.0", args: process.argv.slice(2) }));', 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.equal(result.installedVersion, '7.0.0');
  assert.equal(result.kooCliVersion, getKooCliVersion());
  assert.equal(result.versionMismatch, true);
  assert.match(result.nextStep, /version mismatch/i);
});

test('runVersionCheck reports no versionMismatch when installed version matches kooCliVersion', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, `console.log("当前KooCLI版本:${getKooCliVersion()}");`, 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.equal(result.installedVersion, getKooCliVersion());
  assert.equal(result.versionMismatch, false);
});

test('TOOL_DEFINITIONS includes all required tools including sandbox', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  const required = [
    'huaweicloud_check_cli',
    'huaweicloud_plan_cli_command',
    'huaweicloud_run_readonly_command',
    'huaweicloud_list_operations',
    'huaweicloud_run_approved_command',
    'huaweicloud_show_profile_redacted',
    'huaweicloud_service_catalog',
    'huaweicloud_explain_error',
    'huaweicloud_search_docs',
    'huaweicloud_retrieve_skill',
    'huaweicloud_list_regions',
    'huaweicloud_get_regional_availability',
    'huaweicloud_search_marketplace',
    'huaweicloud_setup_obs_config',
    'huaweicloud_auth_status',
    'huaweicloud_auth_sync',
    'huaweicloud_sandbox_exec_with_session',
    'huaweicloud_sandbox_upload_file',
    'huaweicloud_sandbox_close_session',
    'huaweicloud_sandbox_check_user',
    'huaweicloud_sandbox_sign_agreement',
    'huaweicloud_sandbox_connect',
    'huaweicloud_sandbox_credentials',
    'huaweicloud_voucher_status',
    'huaweicloud_voucher_claim',
    'huaweicloud_list_packs',
    'huaweicloud_pack_info',
    'huaweicloud_list_skills',
    'huaweicloud_secret_set',
    'huaweicloud_secret_list',
    'huaweicloud_secret_delete',
  ] as const;
  for (const name of required) {
    assert.ok(names.includes(name), `Missing tool: ${name}`);
  }
  assert.ok(names.length >= 25);
  assert.ok(names.includes('huaweicloud_search_marketplace'), 'Should have marketplace search tool');
});

test('TOOL_DEFINITIONS expose cwd parameter on run tools', () => {
  const readonlySchema = getToolSchema('huaweicloud_run_readonly_command').toJSONSchema();
  assert.ok(Object.hasOwn(readonlySchema.properties!, 'cwd'), 'run_readonly_command should have cwd param');

  const approvedSchema = getToolSchema('huaweicloud_run_approved_command').toJSONSchema();
  assert.ok(Object.hasOwn(approvedSchema.properties!, 'cwd'), 'run_approved_command should have cwd param');
});

test('TOOL_DEFINITIONS includes proactive hook check tools', () => {
  const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.ok(names.has('huaweicloud_hook_check_command'));
  assert.ok(names.has('huaweicloud_hook_check_artifacts'));
  assert.ok(names.has('huaweicloud_hook_check_deploy_plan'));
});

test('TOOL_SCHEMAS keys exactly match TOOL_DEFINITIONS names (no orphans either way)', () => {
  const registryNames = TOOL_DEFINITIONS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  const schemaKeys = Object.keys(TOOL_SCHEMAS).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    schemaKeys,
    registryNames,
    'a tool registered without a schema is unreachable over MCP; a schema without a registry entry is dead code',
  );
});

test('huaweicloud_hook_check_command returns deny finding', async () => {
  const result = (await callTool('huaweicloud_hook_check_command', {
    command:
      'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
});

test('huaweicloud_explain_error maps APIGW.0301 to credential/project_id guidance', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'unknown',
    errorCode: 'APIGW.0301',
    message: 'Incorrect IAM authentication information',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Incorrect IAM authentication information/);
  assert.match(text, /auth init/);
  assert.match(text, /project_id/);
});

test('huaweicloud_explain_error fallback teaches context capture and error-center lookup (#648)', async () => {
  // Regression input from issue #648 EXP-E08: ECS Ecs.0103 with minimal context
  // fell into the generic fallback and produced only a "collect info" line.
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
  });
  const text = JSON.stringify(result);
  assert.match(text, /--debug/);
  assert.match(text, /X-Request-Id/);
  assert.match(text, /re-call explain_error/);
  assert.match(text, /Ecs\.0103/);
  assert.match(text, /support\.huaweicloud\.com/);
  // requestId was empty, so the support-ticket line must not appear.
  assert.doesNotMatch(text, /Provide the Request ID/);
});

test('huaweicloud_explain_error still appends support line when requestId is present', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
    requestId: 'req-abc-123',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Provide the Request ID \(req-abc-123\) when contacting Huawei Cloud support\./);
});

test('callTool rejects invalid numeric timeoutMs instead of silently ignoring it', async () => {
  await assert.rejects(
    () =>
      callTool('huaweicloud_run_readonly_command', {
        args: ['ECS', 'ListServersDetails'],
        timeoutMs: 'not-a-number',
      } as unknown as ToolArgs),
    /positive number/,
  );
});

test('callTool accepts maxRetries 0 and integer timeoutMs (no false rejection)', async () => {
  // maxRetries: 0 is legitimate ("no retries") and must pass normalization (#530)
  await assert.doesNotReject(() =>
    callTool('huaweicloud_plan_cli_command', { args: ['ECS', 'ListServersDetails'], maxRetries: 0, timeoutMs: 30000 }),
  );
});

test('huaweicloud_hook_check_artifacts detects broad IAM policy', async () => {
  const result = (await callTool('huaweicloud_hook_check_artifacts', {
    artifacts: [
      {
        path: 'policy.json',
        content: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
      },
    ],
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('huaweicloud_hook_check_deploy_plan warns on sandbox without ttl', async () => {
  const result = (await callTool('huaweicloud_hook_check_deploy_plan', {
    plan: {
      environment: 'preview',
      resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
    },
  })) as HookCheckResult;
  assert.equal(result.decision, 'warn');
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].ruleId, 'hwc-sandbox-missing-ttl');
});

test('service_catalog recommends sandbox first for static website deployment intent', async () => {
  const en = (await callTool('huaweicloud_service_catalog', {
    intent: 'deploy a static website',
  })) as ServiceCatalogResult;
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(en.recommendedSkills.includes('huawei-obs'));

  const zh = (await callTool('huaweicloud_service_catalog', {
    intent: '部署静态网站到华为云',
  })) as ServiceCatalogResult;
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');

  const webApp = (await callTool('huaweicloud_service_catalog', {
    intent: 'host a web app for preview',
  })) as ServiceCatalogResult;
  assert.equal(webApp.recommendedSkills[0], 'huawei-sandbox');
});

test('service_catalog keeps storage routing for pure storage intent', async () => {
  const result = (await callTool('huaweicloud_service_catalog', {
    intent: 'store files in an obs bucket',
  })) as ServiceCatalogResult;
  assert.ok(result.recommendedSkills.includes('huawei-obs'));
  assert.notEqual(result.recommendedSkills[0], 'huawei-sandbox');
});

// Symlink creation needs privileges on Windows (the repo's other symlink
// tests skip there for the same reason); GitHub-hosted runners happen to be
// elevated, but the suite must not depend on that.
test(
  'listSkillDirs ignores files, subdirs without SKILL.md, and counts symlinked skill dirs',
  { skip: process.platform === 'win32' },
  () => {
    const base = fixtureDir('huaweicloud-list-skills-');
    try {
      const root = join(base, 'root');
      const external = join(base, 'external');
      mkdirSync(root, { recursive: true });
      mkdirSync(join(external, 'huawei-vpc'), { recursive: true });
      writeFileSync(join(external, 'huawei-vpc', 'SKILL.md'), '---\nname: huawei-vpc\n---\n', 'utf8');
      symlinkSync(join(external, 'huawei-vpc'), join(root, 'huawei-vpc'));
      mkdirSync(join(root, 'no-skill'));
      writeFileSync(join(root, 'stray.md'), 'x');

      assert.deepEqual(
        listSkillDirs(root).sort((a, b) => a.localeCompare(b)),
        ['huawei-vpc'],
      );
      assert.deepEqual(listSkillDirs(join(base, 'missing')), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

// retrieve_skill is the server-side skill loader, so its name boundary is
// security-relevant: traversal-shaped names must be rejected before any
// filesystem access.
test('retrieve_skill rejects traversal-shaped and non-skill names', async () => {
  for (const name of ['../src/packs/obs/skills/huawei-obs', '..%2f..', 'huawei ecs', 'HUAWAI-ECS', '/etc', '']) {
    const result = (await callTool('huaweicloud_retrieve_skill', { name })) as RetrieveSkillResult;
    assert.equal(result.ok, false, `name ${JSON.stringify(name)} must be rejected`);
    assert.match(result.error!, /Invalid skill name|Skill name is required/);
  }
});

test('retrieve_skill serves the full skill from the server-relative tree', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.name, 'huawei-ecs');
  assert.match(result.content!, /^---\r?\nname: huawei-ecs/);
  assert.ok(result.references.length > 0, 'huawei-ecs ships reference files');
  assert.ok(result.references.some((ref) => ref.filename === 'create-instance.md'));
});

// The consumer-level pin of the truncation fix: the parser unit tests and
// the structure invariant guard the module and the corpus, this guards the
// wiring — a future first-line regex dropped back into retrieveSkill fails
// here even though every other gate stays green.
test('retrieve_skill returns the full multi-line description, quote-stripped', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, '1');
  assert.ok(result.description!.startsWith('Use when'), 'the YAML quote must not survive into retrieve_skill output');
  assert.ok(
    result.description!.includes('HC活动场景'),
    'the multi-line second paragraph must survive into retrieve_skill output',
  );
  assert.deepEqual(
    result.references.map((ref) => ref.filename),
    ['create-instance.md', 'evs.md', 'flavors.md', 'hc-activity.md', 'troubleshooting.md'],
    'references list in the same deterministic order list_skills serves',
  );
});

test('search_docs matches tokens from the multi-line description second paragraph', async () => {
  // 'Nginx部署' lives only in huawei-ecs's second paragraph: the CONTENT
  // index path found it even before the multi-line fix (whole-file match),
  // so the discriminating assertion is the snippet — the old first-line
  // snippet was quote-prefixed and paragraph-free.
  const result = (await callTool('huaweicloud_search_docs', { query: 'Nginx部署' })) as {
    ok: boolean;
    results: Array<{ name: string; snippet: string }>;
  };
  assert.equal(result.ok, true);
  const hit = result.results.find((entry) => entry.name === 'huawei-ecs');
  assert.ok(hit, 'the second-paragraph token must find huawei-ecs');
  assert.ok(hit!.snippet.startsWith('Use when'), 'the snippet must carry the quote-stripped description');
});

test('auth_switch temporary sets runtime credentials for api path', async () => {
  const prev = {
    AK: process.env.HW_ACCESS_KEY,
    SK: process.env.HW_SECRET_KEY,
  };
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  try {
    const out = (await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'temporary',
      ak: 'RUNTIME_AK',
      sk: 'RUNTIME_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.scope, 'temporary');
    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved!.ak, 'RUNTIME_AK');
  } finally {
    clearRuntimeCredentials();
    if (prev.AK === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prev.SK;
  }
});

test('auth_switch clear resets runtime', async () => {
  const isolatedHome = fixtureDir('huaweicloud-auth-clear-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = isolatedHome;
  try {
    setRuntimeCredentials('A', 'B', undefined, 'cn-north-4');
    const out = (await callTool('huaweicloud_auth_switch', { action: 'clear' })) as AuthSwitchResult;
    assert.equal(out.status, 'cleared');
    let threw = false;
    try {
      resolveCredentialsWithRuntime({});
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('auth_switch persist(mode=import) rejects missing region and keeps import file (#502)', async () => {
  const home = fixtureDir('auth-import-region-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(importFile, JSON.stringify({ ak: 'IMPORT_AK', sk: 'IMPORT_SK' }), 'utf8');

    const out = (await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'persist' })) as AuthSwitchResult;

    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'invalid_region');
    assert.match(out.error!, /region/);
    // S1 must not be written on a rejected persist.
    assert.equal(existsSync(join(cfgDir, 'credentials.json')), false);
    // Import file must survive for replay.
    assert.equal(existsSync(importFile), true);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});

test('auth_switch temporary(mode=import) clears import file on success', async () => {
  const home = fixtureDir('auth-import-temp-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(importFile, JSON.stringify({ ak: 'TMP_AK', sk: 'TMP_SK' }), 'utf8');

    const out = (await callTool('huaweicloud_auth_switch', {
      mode: 'import',
      action: 'temporary',
    })) as AuthSwitchResult;

    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importFile), false, 'import file should be cleared after successful temporary set');
    assert.equal(resolveCredentialsWithRuntime({})!.ak, 'TMP_AK');
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});

test('auth_switch persist(mode=import) with STS token is rejected and clears import file', async () => {
  const home = fixtureDir('auth-import-sts-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(
      importFile,
      JSON.stringify({ ak: 'STS_AK', sk: 'STS_SK', securityToken: 'STS_TOK', region: 'cn-north-4' }),
      'utf8',
    );

    const out = (await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'persist' })) as AuthSwitchResult;

    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.equal(
      existsSync(importFile),
      false,
      'unfixable STS import must be cleared — no replay value, and no plaintext token residual',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});
