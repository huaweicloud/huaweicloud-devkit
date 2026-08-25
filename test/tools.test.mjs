import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
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

test('runVersionCheck uses hcloud version instead of --version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-version-'));
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ version: "7.0.0", args: process.argv.slice(2) }));', 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.match(result.output, /"version": "7.0.0"/);
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
  ];
  for (const name of required) {
    assert.ok(names.includes(name), `Missing tool: ${name}`);
  }
  assert.ok(names.length >= 23);
  assert.ok(names.includes('huaweicloud_search_marketplace'), 'Should have marketplace search tool');
});

test('TOOL_DEFINITIONS expose cwd parameter on run tools', () => {
  const readonlyTool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_run_readonly_command');
  assert.ok(Object.hasOwn(readonlyTool.inputSchema.properties, 'cwd'), 'run_readonly_command should have cwd param');

  const approvedTool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_run_approved_command');
  assert.ok(Object.hasOwn(approvedTool.inputSchema.properties, 'cwd'), 'run_approved_command should have cwd param');
});

test('TOOL_DEFINITIONS includes proactive hook check tools', () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.ok(names.includes('huaweicloud_hook_check_command'));
  assert.ok(names.includes('huaweicloud_hook_check_artifacts'));
  assert.ok(names.includes('huaweicloud_hook_check_deploy_plan'));
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

    assert.deepEqual(listSkillDirs(root).sort(), ['huawei-vpc']);
    assert.deepEqual(listSkillDirs(join(base, 'missing')), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
