// The tool-roster tables and the trimmed-list assertion for the
// plugins-e2e suites, extracted from the harness so each module stays
// single-purpose.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invokeMcpSequence, listTools, makeEnv, runCli } from './plugins-e2e-harness.ts';

export const REQUIRED_TOOLS = [
  'huaweicloud_hook_check_command',
  'huaweicloud_hook_check_artifacts',
  'huaweicloud_hook_check_deploy_plan',
  'huaweicloud_service_catalog',
  'huaweicloud_explain_error',
  'huaweicloud_search_docs',
  'huaweicloud_retrieve_skill',
  'huaweicloud_get_regional_availability',
  'huaweicloud_list_packs',
  'huaweicloud_pack_info',
  'huaweicloud_list_skills',
  'huaweicloud_packs_configure',
];

// Optional-pack tools, grouped by pack id (same grouping as
// packs/registry.ts). Together with REQUIRED_TOOLS these cover every registered tool.
export const PER_PACK_TOOLS = {
  'huaweicloud-cli': [
    'huaweicloud_check_cli',
    'huaweicloud_plan_cli_command',
    'huaweicloud_run_readonly_command',
    'huaweicloud_list_operations',
    'huaweicloud_run_approved_command',
    'huaweicloud_show_profile_redacted',
    'huaweicloud_list_regions',
  ],
  sandbox: [
    'huaweicloud_sandbox_exec_with_session',
    'huaweicloud_sandbox_exec_one_shot',
    'huaweicloud_sandbox_exec_poll',
    'huaweicloud_sandbox_close_session',
    'huaweicloud_sandbox_upload_file',
    'huaweicloud_sandbox_upload_project',
    'huaweicloud_sandbox_deploy_nginx',
    'huaweicloud_sandbox_deploy_check',
    'huaweicloud_sandbox_check_user',
    'huaweicloud_sandbox_sign_agreement',
    'huaweicloud_sandbox_connect',
    'huaweicloud_sandbox_credentials',
    'huaweicloud_sandbox_shutdown',
    'huaweicloud_sandbox_expose_tunnel',
    'huaweicloud_sandbox_renew_tunnel',
    'huaweicloud_sandbox_keepalive_watchdog',
  ],
  auth: [
    'huaweicloud_auth_status',
    'huaweicloud_auth_sync',
    'huaweicloud_auth_init',
    'huaweicloud_auth_switch',
    'huaweicloud_auth_confirm',
    'huaweicloud_check_account_type',
  ],
  obs: ['huaweicloud_setup_obs_config', 'huaweicloud_obs_set_website_config', 'huaweicloud_obs_set_cors'],
  voucher: ['huaweicloud_voucher_status', 'huaweicloud_voucher_claim', 'huaweicloud_competition_voucher_claim'],
  update: ['huaweicloud_check_update', 'huaweicloud_upgrade'],
  discovery: ['huaweicloud_search_marketplace', 'huaweicloud_get_service_icon', 'huaweicloud_detect_framework'],
  'huaweicloud-open-mcp': ['huaweicloud_gateway_list_tools', 'huaweicloud_gateway_call', 'huaweicloud_gateway_restart'],
};

export const targets = [
  {
    name: 'opencode',
    banner: /\[OpenCode\]/,
    pluginsDir: (h: string) => join(h, '.config', 'opencode', 'huaweicloud-plugins'),
    skillsDir: (h: string) => join(h, '.config', 'opencode', 'huaweicloud-plugins', 'skills'),
    configPath: (h: string) => join(h, '.config', 'opencode', 'opencode.json'),
    hasServer: (p: string) => {
      if (!existsSync(p)) return false;
      try {
        const config = JSON.parse(readFileSync(p, 'utf8')) as { mcp?: Record<string, unknown> };
        return Boolean(config.mcp?.['huaweicloud-devkit']);
      } catch {
        return false;
      }
    },
  },
  {
    name: 'codex-desktop',
    banner: /\[Codex Desktop\]/,
    pluginsDir: (h: string) => join(h, 'plugins', 'huaweicloud-devkit'),
    skillsDir: (h: string) => join(h, 'plugins', 'huaweicloud-devkit', 'skills'),
    configPath: (h: string) => join(h, '.agents', 'plugins', 'marketplace.json'),
    hasServer: (p: string) => {
      if (!existsSync(p)) return false;
      try {
        const mp = JSON.parse(readFileSync(p, 'utf8')) as { plugins: { name?: string }[] };
        return mp.plugins && mp.plugins.some((e) => e.name === 'huaweicloud-devkit');
      } catch {
        return false;
      }
    },
  },
  {
    name: 'workbuddy',
    banner: /\[WorkBuddy\]/,
    pluginsDir: (h: string) => join(h, '.workbuddy', 'huaweicloud-plugins'),
    skillsDir: (h: string) => join(h, '.workbuddy', 'huaweicloud-plugins', 'skills'),
    configPath: (h: string) => join(h, '.workbuddy', 'mcp.json'),
    hasServer: (p: string) => {
      if (!existsSync(p)) return false;
      try {
        const config = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: Record<string, unknown> };
        return Boolean(config.mcpServers?.['huaweicloud-devkit']);
      } catch {
        return false;
      }
    },
  },
];

export async function assertTrimmedToolsList(
  packId: 'sandbox' | 'huaweicloud-open-mcp',
  expectedCount: number,
  expectedLabel: string,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `mcp-trim-${packId}-`));
  const cwd = mkdtempSync(join(tmpdir(), `mcp-trim-${packId}-proj-`));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
    const responses = await invokeMcpSequence(
      mcpServerPath,
      { ...makeEnv(home, cwd), DEVKIT_PACKS: packId },
      listTools,
    );

    assert.ok(responses[0].result, 'initialize returned result');
    assert.ok(responses[1].result, 'tools/list returned result');
    const toolNames = responses[1].result.tools.map((t) => t.name);
    assert.equal(toolNames.length, expectedCount, `expected ${expectedLabel}, got ${toolNames.length}`);

    for (const required of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(required), `Missing core tool: ${required}`);
    }
    for (const name of PER_PACK_TOOLS[packId]) {
      assert.ok(toolNames.includes(name), `Missing ${packId} tool: ${name}`);
    }
    for (const [otherPack, names] of Object.entries(PER_PACK_TOOLS)) {
      if (otherPack === packId) continue;
      for (const name of names) {
        assert.ok(!toolNames.includes(name), `${name} from disabled pack ${otherPack} must not be registered`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}
