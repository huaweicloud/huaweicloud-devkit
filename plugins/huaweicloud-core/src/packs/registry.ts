import type { ToolName } from '../tools.ts';
import type { Pack, PackId, PackToolDefinition } from '../lib/pack-types.ts';
import { updatePack } from './update/pack.ts';
import { sandboxPack } from './sandbox/pack.ts';
import { authPack } from './auth/pack.ts';
import { obsPack } from './obs/pack.ts';
import { voucherPack } from './voucher/pack.ts';
import { discoveryPack } from './discovery/pack.ts';
import { huaweicloudCliPack } from './huaweicloud-cli/pack.ts';
import { huaweicloudOpenMcpPack } from './huaweicloud-open-mcp/pack.ts';
import { secretsPack } from './secrets/pack.ts';
import { UPDATE_TOOL_HANDLERS } from './update/tools.ts';
import { SANDBOX_TOOL_HANDLERS } from './sandbox/tools.ts';
import { AUTH_TOOL_HANDLERS } from './auth/tools.ts';
import { OBS_TOOL_HANDLERS } from './obs/tools.ts';
import { VOUCHER_TOOL_HANDLERS } from './voucher/tools.ts';
import { DISCOVERY_TOOL_HANDLERS } from './discovery/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOL_HANDLERS } from './huaweicloud-open-mcp/tools.ts';
import { HUAWEICLOUD_CLI_TOOL_HANDLERS } from './huaweicloud-cli/tools.ts';
import { SECRETS_TOOL_HANDLERS } from './secrets/tools.ts';

// PackId and the Pack interface live in src/lib/pack-types.ts alongside
// PackToolDefinition, so packs and the registry share one vocabulary module.

// PACK_OF is the single source of truth for tool → pack ownership. The
// satisfies check turns a missing or extra key into a compile error, so this
// map always covers exactly the TOOL_DEFINITIONS registry.
export const PACK_OF = {
  huaweicloud_check_cli: 'huaweicloud-cli',
  huaweicloud_plan_cli_command: 'huaweicloud-cli',
  huaweicloud_run_readonly_command: 'huaweicloud-cli',
  huaweicloud_list_operations: 'huaweicloud-cli',
  huaweicloud_run_approved_command: 'huaweicloud-cli',
  huaweicloud_show_profile_redacted: 'huaweicloud-cli',
  huaweicloud_hook_check_command: 'core',
  huaweicloud_hook_check_artifacts: 'core',
  huaweicloud_hook_check_deploy_plan: 'core',
  huaweicloud_service_catalog: 'core',
  huaweicloud_explain_error: 'core',
  huaweicloud_search_docs: 'core',
  huaweicloud_retrieve_skill: 'core',
  huaweicloud_list_regions: 'huaweicloud-cli',
  huaweicloud_get_regional_availability: 'core',
  huaweicloud_list_packs: 'core',
  huaweicloud_pack_info: 'core',
  huaweicloud_list_skills: 'core',
  huaweicloud_packs_configure: 'core',
  huaweicloud_search_marketplace: 'discovery',
  huaweicloud_get_service_icon: 'discovery',
  huaweicloud_detect_framework: 'discovery',
  huaweicloud_setup_obs_config: 'obs',
  huaweicloud_obs_set_website_config: 'obs',
  huaweicloud_auth_status: 'auth',
  huaweicloud_auth_sync: 'auth',
  huaweicloud_auth_init: 'auth',
  huaweicloud_auth_switch: 'auth',
  huaweicloud_auth_confirm: 'auth',
  huaweicloud_sandbox_exec_with_session: 'sandbox',
  huaweicloud_sandbox_exec_one_shot: 'sandbox',
  huaweicloud_sandbox_close_session: 'sandbox',
  huaweicloud_sandbox_upload_file: 'sandbox',
  huaweicloud_sandbox_upload_project: 'sandbox',
  huaweicloud_sandbox_deploy_nginx: 'sandbox',
  huaweicloud_sandbox_deploy_check: 'sandbox',
  huaweicloud_sandbox_check_user: 'sandbox',
  huaweicloud_sandbox_sign_agreement: 'sandbox',
  huaweicloud_sandbox_connect: 'sandbox',
  huaweicloud_sandbox_credentials: 'sandbox',
  huaweicloud_voucher_status: 'voucher',
  huaweicloud_voucher_claim: 'voucher',
  huaweicloud_check_update: 'update',
  huaweicloud_upgrade: 'update',
  huaweicloud_gateway_list_tools: 'huaweicloud-open-mcp',
  huaweicloud_gateway_call: 'huaweicloud-open-mcp',
  huaweicloud_gateway_restart: 'huaweicloud-open-mcp',
  huaweicloud_secret_set: 'secrets',
  huaweicloud_secret_list: 'secrets',
  huaweicloud_secret_delete: 'secrets',
} as const satisfies Record<ToolName, PackId>;

// The pack-owned tool names: every PACK_OF key whose owner is not core.
// Derived from PACK_OF (the ownership truth) rather than hand-listed from the
// per-pack XToolName unions, so moving a tool into a pack automatically adds
// it here — and the PACK_TOOL_HANDLERS check below immediately demands its
// handler.
type NonCoreToolNames = {
  [K in keyof typeof PACK_OF]: (typeof PACK_OF)[K] extends Exclude<PackId, 'core'> ? K : never;
}[keyof typeof PACK_OF];
export type PackToolName = NonCoreToolNames;

// Central pack dispatch table: the nine per-pack handler maps merged once
// (DISCOVERY, OBS, AUTH, SANDBOX, VOUCHER, UPDATE, OPENAPI, HUAWEICLOUD_CLI,
// SECRETS).
// The satisfies check closes the loop at compile time — a pack tool that
// exists in PACK_OF but has no merged handler entry (missing from a pack's
// X_TOOL_HANDLERS, or a whole pack's spread forgotten here) fails the build
// instead of failing at call time. Same spread-merge shape as TOOL_SCHEMAS
// in tool-schemas.ts.
export const PACK_TOOL_HANDLERS = {
  ...DISCOVERY_TOOL_HANDLERS,
  ...OBS_TOOL_HANDLERS,
  ...AUTH_TOOL_HANDLERS,
  ...SANDBOX_TOOL_HANDLERS,
  ...VOUCHER_TOOL_HANDLERS,
  ...UPDATE_TOOL_HANDLERS,
  ...HUAWEICLOUD_OPEN_MCP_TOOL_HANDLERS,
  ...HUAWEICLOUD_CLI_TOOL_HANDLERS,
  ...SECRETS_TOOL_HANDLERS,
} satisfies Record<PackToolName, PackToolDefinition['handler']>;

// Runtime guard over the same table: true exactly for the PackToolName
// literals. callTool dispatches pack tools through it before the core
// switch, and the narrowing it provides is what keeps the switch's
// never-guard honest about covering only the core remainder.
export function isPackToolName(name: ToolName): name is PackToolName {
  return Object.hasOwn(PACK_TOOL_HANDLERS, name);
}

// Per-pack tool lists invert PACK_OF instead of hand-writing name lists, so a
// pack can never claim an unassigned or non-existent tool.
function toolsFor(id: PackId): ToolName[] {
  return (Object.keys(PACK_OF) as ToolName[]).filter((tool) => PACK_OF[tool] === id);
}

// skills are claims over the plugin skills/ directories; the pack tests fail
// when one is claimed twice, left unclaimed, or removed. Every skill's
// authoritative source lives in its owning pack's skills/ dir — the six
// meta-skills in src/packs/core/skills/, the twenty service skills in
// src/packs/huaweicloud-cli/skills/ — generated into the runtime tree by
// scripts/sync-skills.mjs.
export const PACKS: readonly Pack[] = [
  {
    id: 'core',
    title: 'Core',
    description:
      'KooCLI command planning and execution, hook risk checks, capability catalog, documentation and skill retrieval, and region discovery for Huawei Cloud agent tasks.',
    skills: [
      'huaweicloud-api-and-sdk',
      'huaweicloud-capability-discovery',
      'huaweicloud-cli-and-auth',
      'huaweicloud-core',
      'huaweicloud-safety',
      'huaweicloud-troubleshooting',
    ],
    tools: toolsFor('core'),
  },
  huaweicloudCliPack,
  sandboxPack,
  authPack,
  obsPack,
  voucherPack,
  updatePack,
  discoveryPack,
  huaweicloudOpenMcpPack,
  secretsPack,
];
