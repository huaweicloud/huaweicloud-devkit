// The tool name/description registry, split out of tools.ts (the dispatch
// shell keeps the face; this module owns the literals). TOOL_DEFINITIONS_LITERALS
// is the single source of truth for names; core descriptions live here, pack
// descriptions are derived from the owning packs' X_TOOLS arrays. `as const`
// keeps the tool names literal so ToolName below is derived from the registry
// itself. callTool dispatches on two paths, both closed at compile time: pack
// tools (PACK_OF owners ≠ core) go through the central PACK_TOOL_HANDLERS map
// (satisfies-checked in packs/registry.ts), core tools through the switch in
// tools.ts whose never-guard pins every core name to a case. Input schemas live
// in tool-schemas.ts (zod, single source of truth for validation and tools/list
// rendering); its `satisfies Record<ToolName, ...>` check pins the schema map
// to exactly these names.
import { AUTH_TOOLS } from './packs/auth/tools.ts';
import { OBS_TOOLS } from './packs/obs/tools.ts';
import { VOUCHER_TOOLS } from './packs/voucher/tools.ts';
import { DISCOVERY_TOOLS } from './packs/discovery/tools.ts';
import { SANDBOX_TOOLS } from './packs/sandbox/tools.ts';
import { UPDATE_TOOLS } from './packs/update/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOLS } from './packs/huaweicloud-open-mcp/tools.ts';
import { HUAWEICLOUD_CLI_TOOLS } from './packs/huaweicloud-cli/tools.ts';
import { SECRETS_TOOLS } from './packs/secrets/tools.ts';
// The pack tool arrays own the pack tools' names and descriptions; this
// registry derives its pack entries from the same arrays (registry.ts
// already pulls every pack module into this import graph for the handler
// maps, so these edges add no new runtime module).

const packToolDescriptions = new Map<string, string>();
for (const tools of [
  AUTH_TOOLS,
  OBS_TOOLS,
  VOUCHER_TOOLS,
  DISCOVERY_TOOLS,
  SANDBOX_TOOLS,
  UPDATE_TOOLS,
  HUAWEICLOUD_OPEN_MCP_TOOLS,
  HUAWEICLOUD_CLI_TOOLS,
  SECRETS_TOOLS,
]) {
  for (const tool of tools) packToolDescriptions.set(tool.name, tool.description);
}

// Fail-fast at module load: a literal name without a pack X_TOOLS entry
// would otherwise serve `undefined` as the description through a type that
// claims string.
function packDescription(name: string): string {
  const description = packToolDescriptions.get(name);
  if (description === undefined) throw new Error(`pack tool ${name} has no X_TOOLS entry`);
  return description;
}

export const TOOL_DEFINITIONS_LITERALS = [
  {
    name: 'huaweicloud_check_cli',
    description: packDescription('huaweicloud_check_cli'),
  },
  {
    name: 'huaweicloud_plan_cli_command',
    description: packDescription('huaweicloud_plan_cli_command'),
  },
  {
    name: 'huaweicloud_run_readonly_command',
    description: packDescription('huaweicloud_run_readonly_command'),
  },
  {
    name: 'huaweicloud_list_operations',
    description: packDescription('huaweicloud_list_operations'),
  },
  {
    name: 'huaweicloud_run_approved_command',
    description: packDescription('huaweicloud_run_approved_command'),
  },
  {
    name: 'huaweicloud_show_profile_redacted',
    description: packDescription('huaweicloud_show_profile_redacted'),
  },
  {
    name: 'huaweicloud_hook_check_command',
    description: 'Check a planned shell or hcloud command against Huawei Cloud hook risk rules without executing it.',
  },
  {
    name: 'huaweicloud_hook_check_artifacts',
    description: 'Check generated code, IaC, policy, or config artifacts against Huawei Cloud hook risk rules.',
  },
  {
    name: 'huaweicloud_hook_check_deploy_plan',
    description:
      'Check a structured or textual deployment plan for Huawei Cloud sandbox, exposure, IAM, and cost risks.',
  },
  {
    name: 'huaweicloud_service_catalog',
    description:
      'Route a Huawei Cloud task intent to capability sources. Takes intent (plain-language task such as "create an ECS instance", "static website on OBS", "bind an EIP", "troubleshoot an RDS failover") and returns recommended skill names to load with huaweicloud_retrieve_skill, the Huawei Cloud services involved, and the capability order (Skills, KooCLI, API, SDK, MCP, Terraform). Start here when the user\'s task is a Huawei Cloud one and mentions any of its services or scenarios: ECS, VPC, OBS, RDS, CCE, IAM, security groups, EIP, serverless, Kubernetes, database, monitoring, billing, backup, and twenty more domains. If no vendor is named or inferable (explicit mention, hcloud/KooCLI artifacts, myhuaweicloud endpoints, Huawei region IDs, earlier turns), ask which cloud the user means before calling this tool — the vocabulary above is common to several clouds and is not vendor evidence. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description.',
  },
  {
    name: 'huaweicloud_explain_error',
    description: 'Explain a Huawei Cloud CLI, API, SDK, or agent workflow error and suggest next diagnostic steps.',
  },
  {
    name: 'huaweicloud_search_docs',
    description:
      'Search across Huawei Cloud SKILL.md files and local documentation. Returns top 10 relevant results with source, name, snippet, and relevance score. Use when the agent needs to discover which skill covers a topic, or is uncertain about API parameters, quotas, or limitations.',
  },
  {
    name: 'huaweicloud_retrieve_skill',
    description:
      "Retrieve one Huawei Cloud skill by exact name (e.g. huawei-ecs, huawei-vpc, huawei-obs, huawei-sandbox) — the fallback loader, not the default: attempt the direct read first. When the skills tree location is known (stdio server instructions state it at initialize; huaweicloud_list_skills and this tool's own stdio payloads carry it as skillRoot), read <skillRoot>/<name>/SKILL.md and only the references/ files you need with your file tools — untruncated, and do not call this tool before the read is attempted (the attempt itself is the reachability check). Call it only after a direct read attempt fails or is denied, or when the tree location is unknown — it needs no file access. Returns the full SKILL.md content plus its reference files (each reference body capped at 4000 characters; when a reference is cut, a [truncated] marker names the <skillRoot> direct-read path for the rest) and, on stdio sessions, skillRoot so the next skill can be a direct read. Service skills are server data — never installed into an agent's own skill directory — and this is the owner-pack-gated (a trimmed pack's skills are refused with remediation), telemetry-bearing path remote sessions rely on. The six core meta-skills (huaweicloud-*) are additionally disclosed as native skill copies on directory-loading agents; this tool serves them identically everywhere, so it stays the portable fallback. Browse the catalog first with huaweicloud_list_skills; candidates also come from huaweicloud_service_catalog, huaweicloud_search_docs, or huaweicloud_list_packs.",
  },
  {
    name: 'huaweicloud_list_regions',
    description: packDescription('huaweicloud_list_regions'),
  },
  {
    name: 'huaweicloud_get_regional_availability',
    description:
      'Check if a specific Huawei Cloud service is available in a target region. Use before creating resources to prevent failures from regional unavailability.',
  },
  {
    name: 'huaweicloud_search_marketplace',
    description: packDescription('huaweicloud_search_marketplace'),
  },
  {
    name: 'huaweicloud_get_service_icon',
    description: packDescription('huaweicloud_get_service_icon'),
  },
  {
    name: 'huaweicloud_detect_framework',
    description: packDescription('huaweicloud_detect_framework'),
  },
  {
    name: 'huaweicloud_setup_obs_config',
    description: packDescription('huaweicloud_setup_obs_config'),
  },
  {
    name: 'huaweicloud_auth_status',
    description: packDescription('huaweicloud_auth_status'),
  },
  {
    name: 'huaweicloud_auth_sync',
    description: packDescription('huaweicloud_auth_sync'),
  },
  {
    name: 'huaweicloud_auth_init',
    description: packDescription('huaweicloud_auth_init'),
  },
  {
    name: 'huaweicloud_auth_switch',
    description: packDescription('huaweicloud_auth_switch'),
  },
  {
    name: 'huaweicloud_auth_confirm',
    description: packDescription('huaweicloud_auth_confirm'),
  },
  {
    name: 'huaweicloud_sandbox_exec_with_session',
    description: packDescription('huaweicloud_sandbox_exec_with_session'),
  },
  {
    name: 'huaweicloud_sandbox_exec_one_shot',
    description: packDescription('huaweicloud_sandbox_exec_one_shot'),
  },
  {
    name: 'huaweicloud_sandbox_exec_poll',
    description: packDescription('huaweicloud_sandbox_exec_poll'),
  },
  {
    name: 'huaweicloud_sandbox_close_session',
    description: packDescription('huaweicloud_sandbox_close_session'),
  },
  {
    name: 'huaweicloud_sandbox_upload_file',
    description: packDescription('huaweicloud_sandbox_upload_file'),
  },
  {
    name: 'huaweicloud_sandbox_upload_project',
    description: packDescription('huaweicloud_sandbox_upload_project'),
  },
  {
    name: 'huaweicloud_sandbox_deploy_nginx',
    description: packDescription('huaweicloud_sandbox_deploy_nginx'),
  },
  {
    name: 'huaweicloud_sandbox_deploy_check',
    description: packDescription('huaweicloud_sandbox_deploy_check'),
  },
  {
    name: 'huaweicloud_sandbox_expose_tunnel',
    description: packDescription('huaweicloud_sandbox_expose_tunnel'),
  },
  {
    name: 'huaweicloud_sandbox_expose_poll',
    description: packDescription('huaweicloud_sandbox_expose_poll'),
  },
  {
    name: 'huaweicloud_sandbox_check_user',
    description: packDescription('huaweicloud_sandbox_check_user'),
  },
  {
    name: 'huaweicloud_sandbox_sign_agreement',
    description: packDescription('huaweicloud_sandbox_sign_agreement'),
  },
  {
    name: 'huaweicloud_sandbox_connect',
    description: packDescription('huaweicloud_sandbox_connect'),
  },
  {
    name: 'huaweicloud_sandbox_credentials',
    description: packDescription('huaweicloud_sandbox_credentials'),
  },
  {
    name: 'huaweicloud_sandbox_shutdown',
    description: packDescription('huaweicloud_sandbox_shutdown'),
  },
  {
    name: 'huaweicloud_voucher_status',
    description: packDescription('huaweicloud_voucher_status'),
  },
  {
    name: 'huaweicloud_voucher_claim',
    description: packDescription('huaweicloud_voucher_claim'),
  },
  {
    name: 'huaweicloud_competition_voucher_claim',
    description: packDescription('huaweicloud_competition_voucher_claim'),
  },
  {
    name: 'huaweicloud_check_update',
    description: packDescription('huaweicloud_check_update'),
  },
  {
    name: 'huaweicloud_upgrade',
    description: packDescription('huaweicloud_upgrade'),
  },
  {
    name: 'huaweicloud_obs_set_website_config',
    description: packDescription('huaweicloud_obs_set_website_config'),
  },
  {
    name: 'huaweicloud_obs_set_cors',
    description: packDescription('huaweicloud_obs_set_cors'),
  },
  {
    name: 'huaweicloud_check_account_type',
    description: packDescription('huaweicloud_check_account_type'),
  },
  {
    name: 'huaweicloud_sandbox_renew_tunnel',
    description: packDescription('huaweicloud_sandbox_renew_tunnel'),
  },
  {
    name: 'huaweicloud_sandbox_keepalive_watchdog',
    description: packDescription('huaweicloud_sandbox_keepalive_watchdog'),
  },
  {
    name: 'huaweicloud_list_packs',
    description:
      'List the devkit capability packs — the complete skill and tool inventory of this server. Returns each pack with id, title, description, the skill names it owns (browse their metadata with huaweicloud_list_skills, load them with huaweicloud_retrieve_skill), its tool names, and the enabled flag. The "huaweicloud-cli" pack carries the twenty Huawei Cloud service skills (ecs, vpc, obs, iam, rds, ...) with per-service CLI workflows plus the seven KooCLI execution tools (check_cli, plan_cli_command, run_readonly_command, list_operations, run_approved_command, show_profile_redacted, list_regions); the huaweicloud-cli-and-auth skill covers KooCLI installation and credentials. Use this to discover what the devkit knows before picking a skill or pack.',
  },
  {
    name: 'huaweicloud_pack_info',
    description:
      'Inspect one capability pack. Takes pack (a pack id from huaweicloud_list_packs) and returns the pack title, description, claimed skills, enabled flag, and every tool in the pack with name, description, and JSON Schema. Use to decide which pack covers a task before loading a skill with huaweicloud_retrieve_skill.',
  },
  {
    name: 'huaweicloud_list_skills',
    description:
      'List the metadata of every pack-owned skill in one call — name, description, version, owning pack, and reference filenames — the effective catalog: which skills are ENABLED is pack-gated (the operator\u2019s DEVKIT_PACKS posture — a stdio agent session can toggle packs at runtime, see the server instructions), so a huawei-* service skill absent from this list belongs to a trimmed pack; treat it as unavailable and confirm with the user before enabling anything (the six huaweicloud-* meta-skills never appear in the list and are always available — see the exclusion note below). Browse it to pick a skill before paying for huaweicloud_retrieve_skill (which returns the full SKILL.md plus every reference body). On stdio sessions the payload also carries skillRoot, the absolute location of the skills tree — the same location the server instructions state at initialize — and the ONLY root for pack-owned service skills (on directory-loading agents, the native skills directory holding the huaweicloud-* meta-skill copies is a different root; never guess a service skill\u2019s path by analogy to it) — for direct reads: <skillRoot>/<name>/SKILL.md and the references/ files with your own file tools, untruncated and only the file you need (attempt the direct read first — when the attempted read fails or is denied, load via huaweicloud_retrieve_skill instead; the root uses host-native separators; a huaweicloud_search_docs source\u2019s skills/ prefix is this same root). Remote sessions omit skillRoot (the path lives on the server host) — load skills with huaweicloud_retrieve_skill there. Covers the huawei-* service/domain skills of enabled non-core packs, and the six core meta-skills (huaweicloud-*) are excluded by design: directory-loading agents disclose them natively in the system prompt, and huaweicloud_retrieve_skill serves them everywhere. Optional pack filter takes a pack id from huaweicloud_list_packs.',
  },
  {
    name: 'huaweicloud_packs_configure',
    description:
      'Enable or disable capability packs for THIS session, or reset to the operator posture. Session-scoped: the change lives in this server process only and the next session restart restores the DEVKIT_PACKS posture the operator configured. Takes enable (pack ids to add), disable (pack ids to remove; core cannot be disabled), and reset (drop the session override). The refreshed tool list is pushed to the agent immediately. Approval-gated in every mode because widening the disclosure face is the consequence: the no-token call returns USER_CONFIRMATION_REQUIRED naming the pack ids with the approve line for the user\u2019s own terminal (token mode), and under DEVKIT_APPROVAL_MODE=ask the server raises the confirmation itself (a form on a capable client, else an ASK_CONFIRMATION_REQUIRED chat round-trip). Stdio agent sessions only — surfaces with no session state are refused outright. The persistent equivalent is the operator CLI (npx huaweicloud-devkit packs enable <ids> --target <agent>); ask the operator to run it and restart the agent.',
  },
  {
    name: 'huaweicloud_gateway_list_tools',
    description: packDescription('huaweicloud_gateway_list_tools'),
  },
  {
    name: 'huaweicloud_gateway_call',
    description: packDescription('huaweicloud_gateway_call'),
  },
  {
    name: 'huaweicloud_gateway_restart',
    description: packDescription('huaweicloud_gateway_restart'),
  },
  {
    name: 'huaweicloud_secret_set',
    description: packDescription('huaweicloud_secret_set'),
  },
  {
    name: 'huaweicloud_secret_list',
    description: packDescription('huaweicloud_secret_list'),
  },
  {
    name: 'huaweicloud_secret_delete',
    description: packDescription('huaweicloud_secret_delete'),
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS_LITERALS)[number]['name'];

export interface ToolDefinition {
  name: ToolName;
  description: string;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOL_DEFINITIONS_LITERALS;
