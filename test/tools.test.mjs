import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  callTool,
  runVersionCheck,
  TOOL_DEFINITIONS,
  findSkillsRoot,
  listSkillDirs,
} from '../plugins/huaweicloud-core/src/tools.mjs';
import {
  clearRuntimeCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.mjs';

test('runVersionCheck uses hcloud version instead of --version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-version-'));
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
  const result = await runVersionCheck({
    executable: 'nonexistent-hcloud-xyz',
    maxRetries: 0,
  });
  assert.equal(result.installed, false);
  assert.equal(result.errorCode, 'HCLOUD_NOT_FOUND');
  assert.match(result.nextStep, /HCLOUD_BIN/);
});

test('runVersionCheck reports versionMismatch when installed version differs from kooCliVersion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-version-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-version-'));
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
  ];
  for (const name of required) {
    assert.ok(names.includes(name), `Missing tool: ${name}`);
  }
  assert.ok(names.length >= 25);
  assert.ok(names.includes('huaweicloud_search_marketplace'), 'Should have marketplace search tool');
});

test('TOOL_DEFINITIONS expose cwd parameter on run tools', () => {
  const readonlyTool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_run_readonly_command');
  assert.ok(Object.hasOwn(readonlyTool.inputSchema.properties, 'cwd'), 'run_readonly_command should have cwd param');

  const approvedTool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_run_approved_command');
  assert.ok(Object.hasOwn(approvedTool.inputSchema.properties, 'cwd'), 'run_approved_command should have cwd param');
});

test('TOOL_DEFINITIONS includes proactive hook check tools', () => {
  const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.ok(names.has('huaweicloud_hook_check_command'));
  assert.ok(names.has('huaweicloud_hook_check_artifacts'));
  assert.ok(names.has('huaweicloud_hook_check_deploy_plan'));
});

test('huaweicloud_hook_check_command returns deny finding', async () => {
  const result = await callTool('huaweicloud_hook_check_command', {
    command:
      'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  });
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

test('callTool rejects invalid numeric timeoutMs instead of silently ignoring it', async () => {
  await assert.rejects(
    () =>
      callTool('huaweicloud_run_readonly_command', { args: ['ECS', 'ListServersDetails'], timeoutMs: 'not-a-number' }),
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
  const result = await callTool('huaweicloud_hook_check_artifacts', {
    artifacts: [
      {
        path: 'policy.json',
        content: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
      },
    ],
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('huaweicloud_hook_check_deploy_plan warns on sandbox without ttl', async () => {
  const result = await callTool('huaweicloud_hook_check_deploy_plan', {
    plan: {
      environment: 'preview',
      resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
    },
  });
  assert.equal(result.decision, 'warn');
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].ruleId, 'hwc-sandbox-missing-ttl');
});

test('service_catalog recommends sandbox first for static website deployment intent', async () => {
  const en = await callTool('huaweicloud_service_catalog', { intent: 'deploy a static website' });
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(en.recommendedSkills.includes('huawei-obs'));

  const zh = await callTool('huaweicloud_service_catalog', { intent: '部署静态网站到华为云' });
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');

  const webApp = await callTool('huaweicloud_service_catalog', { intent: 'host a web app for preview' });
  assert.equal(webApp.recommendedSkills[0], 'huawei-sandbox');
});

test('service_catalog keeps storage routing for pure storage intent', async () => {
  const result = await callTool('huaweicloud_service_catalog', { intent: 'store files in an obs bucket' });
  assert.ok(result.recommendedSkills.includes('huawei-obs'));
  assert.notEqual(result.recommendedSkills[0], 'huawei-sandbox');
});

test('findSkillsRoot skips stale dirs without SKILL.md and picks the first real skills root', () => {
  const base = mkdtempSync(join(tmpdir(), 'huaweicloud-skills-root-'));
  try {
    const empty = join(base, 'empty');
    const stale = join(base, 'stale');
    const real = join(base, 'real');
    mkdirSync(empty);
    mkdirSync(stale);
    mkdirSync(join(stale, 'leftover'), { recursive: true });
    mkdirSync(join(real, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(real, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');

    assert.equal(findSkillsRoot([empty, stale, real]), real);
    assert.equal(findSkillsRoot([empty, stale]), null);
    assert.equal(findSkillsRoot([]), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listSkillDirs ignores files, subdirs without SKILL.md, and counts symlinked skill dirs', () => {
  const base = mkdtempSync(join(tmpdir(), 'huaweicloud-list-skills-'));
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
});

test('auth_switch temporary sets runtime credentials for api path', async () => {
  const prev = {
    AK: process.env.HW_ACCESS_KEY,
    SK: process.env.HW_SECRET_KEY,
  };
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  try {
    const out = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'temporary',
      ak: 'RUNTIME_AK',
      sk: 'RUNTIME_SK',
      region: 'cn-north-4',
    });
    assert.equal(out.scope, 'temporary');
    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved.ak, 'RUNTIME_AK');
  } finally {
    clearRuntimeCredentials();
    if (prev.AK === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prev.SK;
  }
});

test('auth_switch clear resets runtime', async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'huaweicloud-auth-clear-'));
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = isolatedHome;
  try {
    setRuntimeCredentials('A', 'B', undefined, 'cn-north-4');
    const out = await callTool('huaweicloud_auth_switch', { action: 'clear' });
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
  const home = mkdtempSync(join(tmpdir(), 'auth-import-region-'));
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(importFile, JSON.stringify({ ak: 'IMPORT_AK', sk: 'IMPORT_SK' }), 'utf8');

    const out = await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'persist' });

    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'invalid_region');
    assert.match(out.error, /region/);
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
  const home = mkdtempSync(join(tmpdir(), 'auth-import-temp-'));
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(importFile, JSON.stringify({ ak: 'TMP_AK', sk: 'TMP_SK' }), 'utf8');

    const out = await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'temporary' });

    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importFile), false, 'import file should be cleared after successful temporary set');
    assert.equal(resolveCredentialsWithRuntime({}).ak, 'TMP_AK');
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});

test('auth_switch persist(mode=import) with STS token is rejected and clears import file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'auth-import-sts-'));
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

    const out = await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'persist' });

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
