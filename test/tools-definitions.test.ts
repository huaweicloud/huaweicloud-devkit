import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { fixtureDir } from './fixture-dir.ts';
import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { runVersionCheck } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';
import { getToolSchema, TOOL_SCHEMAS } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.ts';

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
  // #900: top-level nextStep is executable; verbose guidance moved to raw.
  assert.match(result.nextStep, /^(npx |hcloud )/);
  assert.equal(result.nextStep, 'npx huaweicloud-devkit install-hcloud');
  assert.match(result.raw, /koocli-install\.log/);
  assert.doesNotMatch(result.nextStep, /restart the agent/i);
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
  // #900: executable top-level nextStep; English detail only in raw.
  assert.match(result.nextStep, /^npx /);
  assert.match(result.raw, /version mismatch/i);
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
    'huaweicloud_sandbox_shutdown',
    'huaweicloud_sandbox_expose_tunnel',
    'huaweicloud_voucher_status',
    'huaweicloud_voucher_claim',
    'huaweicloud_competition_voucher_claim',
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

test('every top-level parameter on every tool schema carries a description', () => {
  const missing: string[] = [];
  for (const name of Object.keys(TOOL_SCHEMAS) as Array<keyof typeof TOOL_SCHEMAS>) {
    const js = getToolSchema(name).toJSONSchema();
    for (const [key, prop] of Object.entries(js.properties ?? {})) {
      if (!prop || typeof prop !== 'object' || !(prop as Record<string, unknown>).description) {
        missing.push(name + '.' + key);
      }
    }
  }
  assert.deepEqual(missing, [], 'every agent-facing parameter must be described on the raw tools/list face');
});
