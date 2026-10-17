import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { evaluateArtifacts, evaluateCommandRisk, evaluateDeployPlan, type RiskEvaluation } from './risk-rule-engine.ts';
import { classifyTextCommand } from './safety-policy.ts';
import { trackToolInvoke, trackSkillRetrieve } from './telemetry/telemetry.ts';
// The update tool handlers live in the update pack's handler map (merged
// into PACK_TOOL_HANDLERS); only the DistTags type for the CallToolOptions
// doQuery seam is still needed here.
import type { DistTags } from './update-check.ts';
import { getToolSchema, SCHEMA_DRIFT_IGNORED_KEYS } from './tool-schemas.ts';
// PACK_TOOL_HANDLERS is the central pack dispatch table (its satisfies check
// pins every PackToolName to a handler); PACKS feeds the pack meta tools.
import { PACKS, PACK_TOOL_HANDLERS, isPackToolName, type PackToolName } from './packs/registry.ts';
import {
  resolveEnabledPacks,
  setRuntimePacksOverride,
  clearRuntimePacksOverride,
  runtimePacksOverride,
} from './packs/enable.ts';
import { PACK_IDS, type PackId } from './lib/pack-types.ts';
import { closePackEnablement } from './lib/dependency-model.ts';
// The skill-dir listing lives in the shared zod-free module
// (src/lib/skill-tree.ts) so the boot guard, the installer's doctor check,
// the build-time --check stray scan, and validate-package's skill gate all
// hold one membership predicate (dir-or-symlink with a SKILL.md).
import { listSkillDirs } from './lib/skill-tree.ts';
// The frontmatter field extraction (name/description/version) behind
// searchDocs, retrieveSkill, and listSkills — one parser instead of the
// per-call-site regexes that truncated multi-line descriptions.
import { parseSkillFrontmatter } from './lib/skill-frontmatter.ts';
import { recordToolCall, traceEnabled } from './lib/call-trace.ts';
// Service region descriptor (the old inline `known` table in
// getRegionalAvailability, migrated verbatim — see services/regions.ts for
// its guarantee scope).
import { SERVICE_REGIONS } from './services/regions.ts';
// The pack tool arrays own the pack tools' names and descriptions; this
// directory derives its pack entries from the same arrays (registry.ts
// already pulls every pack module into this import graph for the handler
// maps, so these edges add no new runtime module).
import { AUTH_TOOLS } from './packs/auth/tools.ts';
import { OBS_TOOLS } from './packs/obs/tools.ts';
import { VOUCHER_TOOLS } from './packs/voucher/tools.ts';
import { DISCOVERY_TOOLS } from './packs/discovery/tools.ts';
import { SANDBOX_TOOLS } from './packs/sandbox/tools.ts';
import { UPDATE_TOOLS } from './packs/update/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOLS } from './packs/huaweicloud-open-mcp/tools.ts';
import { HUAWEICLOUD_CLI_TOOLS } from './packs/huaweicloud-cli/tools.ts';
import { SECRETS_TOOLS } from './packs/secrets/tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The skills tree is server data, not an agent-native artifact: it ships next
// to dist/ (esbuild preserves import.meta.url, so the bundled mcp-server.js
// resolves this relative to its own location) and is disclosed through the
// MCP tools (list_packs / pack_info / list_skills / retrieve_skill /
// search_docs); list_skills also carries the tree's location (skillRoot,
// stdio sessions only) so a same-machine agent can read the files with its
// own tools. The installer separately places the six core meta-skills as
// native copies in directory-loading agents (setup-cli's PAYLOAD_TARGETS
// sync) — that placement lives in setup-cli, and this module never probes
// agent-native dirs.
const SKILLS_ROOT = join(__dirname, '..', 'skills');

// Re-exported for the existing test importers (test/tools.test.ts); the
// tool handlers below (retrieve_skill, search_docs) consume the local
// binding. The predicate itself lives in src/lib/skill-tree.ts.
export { listSkillDirs };

// Boot-time cross-check between the registry's skill claims and the
// generated tree. A server that advertises skills retrieve_skill cannot
// serve (registry-driven list_packs beside an empty or partial tree) is
// worse than one that refuses to start, so the factory calls this before
// registering anything — mirroring the loudness of a missing dist/.
// The tree must EQUAL the registry roster, not merely contain it: an
// unclaimed directory is served ungated (SKILL_OWNER.get returns undefined,
// so retrieve_skill skips the pack-enablement gate), so extras are as
// dangerous as gaps. The root is injectable for tests.
export function verifySkillTree(root: string = SKILLS_ROOT): void {
  const present = new Set(listSkillDirs(root));
  const missing = [...SKILL_OWNER.keys()].filter((skill) => !present.has(skill));
  const unclaimed = [...present].filter((skill) => !SKILL_OWNER.has(skill));
  if (missing.length > 0 || unclaimed.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (unclaimed.length > 0) parts.push(`unclaimed ${unclaimed.join(', ')}`);
    throw new Error(
      `skills tree invalid at ${root}: ${parts.join('; ')} — ` +
        'from a git checkout run: npm run build; from an install run: npx huaweicloud-devkit install',
    );
  }
}

// ── Tool registry ──
// TOOL_DEFINITIONS_LITERALS is the single source of truth for names; core
// descriptions live here, pack descriptions are derived from the owning
// packs' X_TOOLS arrays below. `as const` keeps the tool names literal so
// ToolName below is derived from the registry itself. callTool dispatches on
// two paths, both closed at compile time: pack tools (PACK_OF owners ≠ core)
// go through the central PACK_TOOL_HANDLERS map (satisfies-checked in
// packs/registry.ts), core tools through the switch below whose never-guard
// pins every core name to a case. Input schemas live in tool-schemas.ts
// (zod, single source of truth for validation and tools/list rendering);
// its `satisfies Record<ToolName, ...>` check pins the schema map to exactly
// these names.
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

const TOOL_DEFINITIONS_LITERALS = [
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
      'Route a Huawei Cloud task intent to capability sources. Takes intent (plain-language task such as "create an ECS instance", "static website on OBS", "bind an EIP", "troubleshoot an RDS failover") and returns recommended skill names to load with huaweicloud_retrieve_skill, the Huawei Cloud services involved, and the capability order (Skills, KooCLI, API, SDK, MCP, Terraform). Start here when the user mentions any Huawei Cloud service or scenario: ECS, VPC, OBS, RDS, CCE, IAM, security groups, EIP, serverless, Kubernetes, database, monitoring, billing, backup, and twenty more domains.',
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
      "Retrieve one Huawei Cloud skill by exact name (e.g. huawei-ecs, huawei-vpc, huawei-obs, huawei-sandbox). Returns the full SKILL.md content plus its reference files (each reference body capped at 4000 characters). Service skills are server data — never installed into an agent's own skill directory — and this tool loads them on every surface: the DEVKIT_PACKS-gated, telemetry-bearing, portable path remote sessions and manifest-based agents rely on. On stdio sessions, a same-machine agent may instead read the files directly under the skillRoot huaweicloud_list_skills discloses. The six core meta-skills (huaweicloud-*) are additionally disclosed as native skill copies on directory-loading agents; this tool serves them identically everywhere, so it stays the portable load path. Browse the catalog first with huaweicloud_list_skills; candidates also come from huaweicloud_service_catalog, huaweicloud_search_docs, or huaweicloud_list_packs.",
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
    name: 'huaweicloud_voucher_status',
    description: packDescription('huaweicloud_voucher_status'),
  },
  {
    name: 'huaweicloud_voucher_claim',
    description: packDescription('huaweicloud_voucher_claim'),
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
      'List the metadata of every pack-owned skill in one call — name, description, version, owning pack, and reference filenames — so the agent can browse the catalog and pick a skill before paying for huaweicloud_retrieve_skill (which returns the full SKILL.md plus every reference body). The payload also carries skillRoot, the absolute location of the skills tree (stdio sessions only): on a same-machine install, read <skillRoot>/<name>/SKILL.md and the references/ files with your own file tools the way you explore native skills — untruncated, and only the reference you need (the root uses host-native separators; a huaweicloud_search_docs source\u2019s skills/ prefix is this same root). Remote sessions omit skillRoot (the path lives on the server host) — load skills with huaweicloud_retrieve_skill there. Covers the huawei-* service/domain skills of enabled non-core packs; skills of packs disabled through DEVKIT_PACKS are omitted, and the six core meta-skills (huaweicloud-*) are excluded by design: directory-loading agents disclose them natively in the system prompt, and huaweicloud_retrieve_skill serves them everywhere. Optional pack filter takes a pack id from huaweicloud_list_packs.',
  },
  {
    name: 'huaweicloud_packs_configure',
    description:
      'Enable or disable capability packs for THIS session, or reset to the operator posture. Session-scoped: the change lives in this server process only and the next session restart restores the DEVKIT_PACKS posture the operator configured. Takes enable (pack ids to add), disable (pack ids to remove; core cannot be disabled), and reset (drop the session override). The refreshed tool list is pushed to the agent immediately. Confirm with the user before enabling a pack the operator trimmed: widening re-exposes that pack\u2019s tools, including state mutators that carry no approval chain of their own. The persistent equivalent is the operator CLI (npx huaweicloud-devkit packs enable <ids> --target <agent>); ask the operator to run it and restart the agent.',
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

// Tool arguments as declared by the per-tool inputSchemas above. Only
// required-field presence is validated upstream (mcp-protocol) and the numeric
// fields are re-derived by normalizeNumericArgs (#530); the remaining field
// types follow the declared contract. Kept as a type alias (not an interface)
// so it stays assignable to/from Record<string, unknown> at the dispatch
// boundary without casts.
export type ToolArgs = {
  args?: string[];
  allowWrites?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  cwd?: string;
  stdin?: string;
  service?: string;
  profile?: string;
  command?: string;
  artifacts?: unknown[];
  plan?: unknown;
  intent?: string;
  errorCode?: string;
  message?: string;
  requestId?: string;
  query?: string;
  topic?: string;
  name?: string;
  region?: string;
  category?: string;
  pack?: string;
  enable?: string[];
  disable?: string[];
  reset?: boolean;
  projectPath?: string;
  target?: string;
  ak?: string;
  sk?: string;
  securityToken?: string;
  clear?: boolean;
  mode?: string;
  action?: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
  approvalToken?: string;
  approvedByUser?: boolean;
  bucket?: string;
  token?: string;
  decision?: string;
  workspace_id?: string;
  username?: string;
  timeout_ms?: number;
  local_path?: string;
  remote_path?: string;
  local_dir?: string;
  remote_dir?: string;
  exclude?: string[];
  extract?: boolean;
  nginx_type?: string;
  port?: number;
  project?: string;
  output_dir?: string;
  node_port?: number;
  public_port?: number;
  config_name?: string;
  framework_type?: string;
  source?: string;
  template_id?: string;
  flavor_id?: string;
  env?: Record<string, unknown>;
  git?: SandboxGitConfig;
  session_id?: string;
  dev_stage_id?: string;
  enable_sts?: boolean;
  api_key?: string;
  domain_id?: string;
  dismiss?: boolean;
  dismissVersion?: string;
  version?: string;
  indexDocument?: string;
  errorDocument?: string;
  ref?: string;
  channel?: string;
  value?: string;
  file?: string;
  envVar?: string;
  note?: string;
  scope?: string;
};

interface SandboxGitConfig {
  repo_url?: string;
  repo_branch?: string;
  repo_name?: string;
  target_path?: string;
  open_type?: string;
}

export interface CallToolOptions {
  sessionId?: string | null;
  doQuery?: () => Promise<DistTags | null>;
  // Disclosure re-sync seam, wired only by stdio-session constructions in
  // mcp-protocol.ts. Its absence is the guard that keeps the stateless remote
  // from mutating process-shared pack state through a direct unlisted call.
  onPacksChanged?: () => void;
}

function toolInvokeValue(name: ToolName, args: ToolArgs): string {
  if (name === 'huaweicloud_run_readonly_command' || name === 'huaweicloud_run_approved_command') {
    const cmdArgs = args.args || [];
    const filtered = cmdArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-') && !a.includes('='));
    if (filtered.length >= 2) return `hcloud ${filtered.slice(0, 2).join(' ')}`;
  }
  if (name === 'huaweicloud_list_operations' && args.service) {
    return args.service;
  }
  if (name === 'huaweicloud_list_skills' && args.pack) {
    return args.pack;
  }
  if (name === 'huaweicloud_retrieve_skill' && args.name) {
    return args.name;
  }
  if (name === 'huaweicloud_packs_configure') {
    // The delta is the telemetry value: which packs crossed the operator
    // posture line in this session is the auditable fact.
    const parts: string[] = [];
    const enabled = (args.enable ?? []).map((id) => String(id));
    const disabled = (args.disable ?? []).map((id) => String(id));
    if (enabled.length > 0) parts.push('+' + enabled.join(','));
    if (disabled.length > 0) parts.push('-' + disabled.join(','));
    if (args.reset === true) parts.push('reset');
    if (parts.length > 0) return parts.join(' ');
  }
  if (name === 'huaweicloud_hook_check_command' && args.command) {
    const parts = args.command.split(/\s+/).filter((p) => !p.startsWith('--'));
    if (parts[0] === 'hcloud' && parts[1]) return `hcloud ${parts.slice(1, 3).join(' ')}`;
    return parts.slice(0, 2).join(' ');
  }
  // The auditable fact for vault mutations is the ref (and scope), never the
  // value or any channel payload.
  if (name === 'huaweicloud_secret_set' && args.ref) return args.ref;
  if (name === 'huaweicloud_secret_list' && args.scope) return args.scope;
  if (name === 'huaweicloud_secret_delete' && args.ref) return args.ref;
  return '1';
}

// Reject invalid numeric args up front instead of silently coercing them to
// NaN (which downstream defaults would absorb as "no timeout set") — see #530.
const NUMERIC_ARG_KEYS = ['timeoutMs', 'maxRetries', 'timeout_ms'] as const;

function normalizeNumericArgs(args: ToolArgs): ToolArgs {
  const out: ToolArgs = { ...args };
  for (const key of NUMERIC_ARG_KEYS) {
    const value = out[key];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    // timeouts must be positive; maxRetries may be 0 (means "no retries").
    const isRetries = key === 'maxRetries';
    const valid = Number.isFinite(num) && (isRetries ? Number.isSafeInteger(num) && num >= 0 : num > 0);
    if (!valid) {
      throw new Error(
        `Invalid parameter "${key}": expected a ${isRetries ? 'non-negative integer' : 'positive number'}, received ${JSON.stringify(value)}.`,
      );
    }
    out[key] = num;
  }
  return out;
}

export async function callTool(name: ToolName, rawArgs: ToolArgs = {}, opts: CallToolOptions = {}): Promise<unknown> {
  const args = normalizeNumericArgs(rawArgs);
  const toolValue = toolInvokeValue(name, args);
  trackToolInvoke(name, toolValue);

  // Trace sits between normalization and dispatch: it records the shape
  // the handler will actually see, and only calls that reached dispatch —
  // SDK-level zod rejects never get here (see lib/call-trace.ts contract).
  if (!traceEnabled()) return dispatchTool(name, args, opts);
  try {
    const result = await dispatchTool(name, args, opts);
    recordToolCall(name, args, true);
    return result;
  } catch (error) {
    recordToolCall(name, args, false, error);
    throw error;
  }
}

async function dispatchTool(name: ToolName, args: ToolArgs, opts: CallToolOptions): Promise<unknown> {
  // Pack tools (every non-core name) dispatch through the central handler
  // map in packs/registry.ts before the switch; the type guard narrows
  // `name` to the core remainder, which is what the switch below and its
  // never-guard are exhaustive over. opts rides through verbatim: every pack
  // handler takes (args, opts), and the update pack's doQuery/sessionId
  // seams keep reaching their handlers exactly as before the migration.
  if (isPackToolName(name)) {
    return await PACK_TOOL_HANDLERS[name](args, opts);
  }

  switch (name) {
    case 'huaweicloud_hook_check_command':
      return hookResult(evaluateCommandRisk(args.command || ''));
    case 'huaweicloud_hook_check_artifacts':
      return hookResult(evaluateArtifacts(args.artifacts || []));
    case 'huaweicloud_hook_check_deploy_plan':
      return hookResult(evaluateDeployPlan(args.plan || {}));
    case 'huaweicloud_service_catalog':
      return serviceCatalog(args.intent);
    case 'huaweicloud_search_docs':
      return searchDocs(args.query || '', args.topic || 'all');
    case 'huaweicloud_retrieve_skill':
      trackSkillRetrieve(args.name || '');
      return retrieveSkill(args.name || '');
    case 'huaweicloud_get_regional_availability':
      return getRegionalAvailability(args.service || '', args.region || '');
    case 'huaweicloud_explain_error':
      return explainError(args);
    case 'huaweicloud_list_packs':
      return listPacks(opts);
    case 'huaweicloud_pack_info':
      return packInfo(args.pack || '', opts);
    case 'huaweicloud_list_skills':
      return listSkills(args.pack, opts);
    case 'huaweicloud_packs_configure':
      return configurePacks(args, opts);
    default: {
      // Compile-time exhaustiveness over the core remainder: after the
      // PACK_TOOL_HANDLERS lookup above, `name` can only be
      // Exclude<ToolName, PackToolName>; with every core case present the
      // default is unreachable. Adding a core tool without a case — or
      // breaking the pack guard above — makes this never-check fail the
      // build.
      const coreOnly: Exclude<ToolName, PackToolName> = name;
      const _exhaustive: never = coreOnly;
      throw new Error(`Unknown tool: ${String(_exhaustive)}`);
    }
  }
}

function hookResult(result: RiskEvaluation) {
  return {
    ok: result.decision !== 'deny',
    decision: result.decision,
    findings: result.findings,
    nextStep:
      result.decision === 'deny'
        ? 'Revise the command, artifact, or deployment plan before execution.'
        : result.decision === 'warn'
          ? 'Review the warnings with the user before proceeding.'
          : 'No Huawei Cloud hook risk rule matched.',
  };
}

function serviceCatalog(intent: string = '') {
  const it = String(intent).toLowerCase();
  const routeMap = [
    {
      keywords: ['ecs', 'server', 'vm', 'instance', 'compute', 'flavor', 'image'],
      skills: ['huawei-ecs'],
      services: ['ECS'],
    },
    {
      keywords: ['vpc', 'subnet', 'network', 'security group', 'eip', 'nat', 'vpn', 'bandwidth'],
      skills: ['huawei-vpc'],
      services: ['VPC', 'EIP'],
    },
    {
      keywords: ['obs', 'bucket', 'storage', 'object', 'static website', 'static site', 'hosting'],
      skills: ['huawei-obs'],
      services: ['OBS'],
    },
    {
      keywords: ['functiongraph', 'serverless', 'function', 'lambda', 'trigger', 'faas'],
      skills: ['huawei-functiongraph'],
      services: ['FunctionGraph'],
    },
    {
      keywords: ['cce', 'kubernetes', 'k8s', 'container', 'cluster', 'node pool', 'swr', 'docker', 'image registry'],
      skills: ['huawei-cce'],
      services: ['CCE', 'SWR'],
    },
    { keywords: ['apig', 'api gateway', 'publish', 'throttle'], skills: ['huawei-apig'], services: ['APIG'] },
    { keywords: ['rds', 'mysql', 'postgresql', 'database', 'db'], skills: ['huawei-rds'], services: ['RDS'] },
    {
      keywords: ['gaussdb', 'distributed', 'sharding', 'opengauss'],
      skills: ['huawei-gaussdb'],
      services: ['GaussDB'],
    },
    {
      keywords: ['iam', 'permission', 'policy', 'role', 'user', 'ak/sk', 'access key', 'agency'],
      skills: ['huawei-iam'],
      services: ['IAM'],
    },
    {
      keywords: ['dew', 'secret', 'kms', 'encrypt', 'decrypt', 'certificate', 'csms'],
      skills: ['huawei-dew'],
      services: ['CSMS', 'KMS'],
    },
    {
      keywords: ['modelarts', 'ai', 'model', 'training', 'inference', 'machine learning'],
      skills: ['huawei-modelarts'],
      services: ['ModelArts'],
    },
    {
      keywords: ['billing', 'cost', 'bill', 'budget', 'expense', 'bss'],
      skills: ['huawei-billing'],
      services: ['BSS'],
    },
    {
      keywords: ['waf', 'aad', 'ddos', 'firewall', 'web protection'],
      skills: ['huawei-waf-aad'],
      services: ['WAF', 'AAD'],
    },
    {
      keywords: ['smn', 'dms', 'notification', 'message', 'kafka', 'rabbitmq'],
      skills: ['huawei-smn-dms'],
      services: ['SMN', 'DMS'],
    },
    {
      keywords: ['ces', 'monitor', 'alarm', 'metric', 'dashboard', 'cloud eye'],
      skills: ['huawei-cloud-eye'],
      services: ['CES'],
    },
    { keywords: ['cts', 'audit', 'trace', 'tracker'], skills: ['huawei-cts'], services: ['CTS'] },
    { keywords: ['cbr', 'backup', 'restore', 'vault', 'snapshot'], skills: ['huawei-cbr'], services: ['CBR'] },
    {
      keywords: ['deployment', 'deploy', 'ci/cd', 'pipeline', 'release'],
      skills: ['huawei-deployment'],
      services: ['CloudDeploy'],
    },
    {
      keywords: [
        'sandbox',
        'devstation',
        'workspace',
        'terminal',
        'preview',
        'hwlink',
        'website',
        'web app',
        'webapp',
        'hosting',
        '网站',
        '网页',
        '静态',
      ],
      skills: ['huawei-sandbox'],
      services: ['Sandbox', 'DevStation'],
    },
    {
      keywords: ['dds', 'dcs', 'mongodb', 'redis', 'memcached', 'cache', 'document db'],
      skills: ['huawei-dds-dcs'],
      services: ['DDS', 'DCS'],
    },
    {
      keywords: ['openapi', 'api catalog', 'api explorer', 'rest call', 'open api', '全量目录', '接口目录'],
      skills: ['huawei-openapi'],
      services: [],
    },
    {
      keywords: ['voucher', 'coupon', 'incentive', 'credit', '领券', '代金券', '优惠券', '激励金', '领取'],
      skills: ['huawei-voucher'],
      services: ['Incentive Voucher'],
    },
  ];
  const matched = [];
  const tokens = new Set(it.split(/[\s,./-]+/).filter((t) => t.length > 0));
  const cjk = /[\u4e00-\u9fff]/;
  for (const route of routeMap) {
    if (route.keywords.some((kw) => (kw.includes(' ') || cjk.test(kw) ? it.includes(kw) : tokens.has(kw)))) {
      matched.push(route);
    }
  }
  const recommendedSkills = [...new Set(matched.flatMap((r) => r.skills))];
  // Never recommend a skill whose owning pack is disabled — the router must
  // not send the agent to a loader that will refuse (same filter searchDocs
  // applies to its index).
  const enabled = resolveEnabledPacks();
  const gated = recommendedSkills.filter((skill) => {
    const owner = SKILL_OWNER.get(skill);
    return !owner || enabled.has(owner);
  });
  const recommendedServices = [...new Set(matched.flatMap((r) => r.services))].slice(0, 5);

  // Deployment intent (deploy/host/publish a web app or static website) must never
  // default to a storage/other service — recommend the sandbox first.
  const deploymentIntent = /deploy|host|hosting|publish|website|web app|preview|部署|托管|发布|网站|网页/.test(it);
  if (deploymentIntent && gated.includes('huawei-sandbox')) {
    const idx = gated.indexOf('huawei-sandbox');
    gated.splice(idx, 1);
    gated.unshift('huawei-sandbox');
  }

  return {
    intent,
    recommendedSkills: gated.length ? gated : ['Use huaweicloud-core to route intent.'],
    recommendedServices: recommendedServices.length
      ? recommendedServices
      : ['Run hcloud --help to list available services.'],
    capabilityOrder: [
      'Huawei Cloud Skills for task-specific workflows and examples',
      'KooCLI hcloud for local authenticated operations and quick inspection',
      'Huawei Cloud API documentation for exact request and response contracts',
      'Huawei Cloud SDKs for application code integration',
      'Huawei Cloud MCP when an official or approved server is available',
      'Terraform Provider only when IaC reviewability and repeatability are important',
    ],
    ruleOfThumb: {
      skills: 'Start here when the user describes a scenario or wants a guided workflow.',
      cli: 'Use for local diagnostics, read-only inspection, and commands the user can review.',
      api: 'Use for exact service contract, region endpoint, project_id, pagination, and error codes.',
      sdk: 'Use when writing application code that calls Huawei Cloud services.',
      mcp: 'Prefer approved MCP tools when available because tools can carry structured schemas.',
      terraform: 'Keep low priority in V1; suggest it for reviewed infrastructure changes, not quick diagnosis.',
    },
  };
}

// ── Pack meta tools ──
// Both tools read the pack registry (PACK_OF inversion in packs/registry.ts),
// the tool definitions (name/description), the zod schemas, and the live
// enablement set (packs/enable.ts, DEVKIT_PACKS > all packs), so their output
// can never disagree with tools/list: a disabled pack is listed with
// enabled:false, and pack_info refuses to detail it.

// Skill directory → owning pack, inverted from the PACKS claims. The tree is
// server data, so an unclaimed directory is a retired skill name that
// survived a copy: copyServerPayload prunes those on update, and treating
// stragglers as unowned (outside pack gating) is defense in depth — the
// enablement filter in searchDocs/retrieveSkill never crashes on them.
const SKILL_OWNER = new Map<string, PackId>(
  PACKS.flatMap((pack) => pack.skills.map((skill) => [skill, pack.id] as const)),
);

// Deterministic (codepoint, not locale) reference listing shared by the
// skill disclosure tools. Regular files plus symlinks — the same read
// exposure the unfiltered readdir it replaced had (a symlink to a
// directory still throws at read time) — while subdirectories are
// excluded: they are not references retrieve_skill could read, so the
// catalog must not advertise them.
function referenceFilenames(skillName: string): string[] {
  const refDir = join(SKILLS_ROOT, skillName, 'references');
  if (!existsSync(refDir)) return [];
  return readdirSync(refDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function listPacks(opts: CallToolOptions = {}) {
  const enabled = resolveEnabledPacks();
  // packs_configure is core-owned but registered only on surfaces that carry
  // session state (stdio). The meta tools must not advertise a tool where
  // tools/list will never carry it, so core's tool list is filtered by the
  // same seam the registration factory uses.
  const runtimeToggling = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: PACKS.length,
    packs: PACKS.map((pack) => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      skills: pack.skills,
      tools:
        pack.id === 'core' && !runtimeToggling
          ? pack.tools.filter((name) => name !== 'huaweicloud_packs_configure')
          : pack.tools,
      enabled: enabled.has(pack.id),
    })),
  };
}

// Shared enablement remediation: pack_info, list_skills, and retrieve_skill
// serve the same instructions for the same condition, so a wording fix lands
// once. The stdio qualifier keeps the message honest on the stateless
// remote, which never registers the session-toggle tool.
function packEnablementRemediation(packId: string): string {
  return (
    'Enable it for this session with huaweicloud_packs_configure (stdio agent sessions; confirm with the user when the operator trimmed the pack on purpose), or ask the operator to persist it with npx huaweicloud-devkit packs enable ' +
    packId +
    ' --target <agent>, then restart the agent (that command rewrites DEVKIT_PACKS in the agent MCP config).'
  );
}

// Shared refusal for an unknown pack id: names every valid id so the caller
// can retry without a second discovery call.
function packNotFound(packId: string): { ok: false; error: string } {
  const available = PACKS.map((entry) => entry.id).join(', ');
  return { ok: false, error: 'Pack "' + packId + '" not found. Available: ' + available };
}

function packNotEnabled(packId: string): { ok: false; error: string } {
  return { ok: false, error: 'Pack "' + packId + '" is not enabled. ' + packEnablementRemediation(packId) };
}

function packInfo(pack: string, opts: CallToolOptions = {}) {
  const packId = String(pack || '').trim();
  if (!packId) return { ok: false, error: 'Pack id is required.' };
  const found = PACKS.find((entry) => entry.id === packId);
  if (!found) return packNotFound(packId);
  const enabled = resolveEnabledPacks();
  if (!enabled.has(found.id)) return packNotEnabled(found.id);
  // Same surface filter as listPacks: core owns packs_configure, but only
  // session-carrying surfaces register it, and pack_info must not advertise
  // a tool tools/list will never carry.
  const toolNames =
    found.id === 'core' && !opts.onPacksChanged
      ? found.tools.filter((name) => name !== 'huaweicloud_packs_configure')
      : found.tools;
  const tools = toolNames.map((name) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    const schema = z.toJSONSchema(getToolSchema(name)) as Record<string, unknown>;
    for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete schema[key];
    return { name, description: definition?.description ?? '', schema };
  });
  return {
    ok: true,
    pack: found.id,
    title: found.title,
    description: found.description,
    skills: found.skills,
    tools,
    enabled: true,
  };
}

// Skill metadata catalog: one call disclosing every enabled non-core
// pack's skills (name, parsed description, version, owning pack, reference
// filenames) so an agent can browse before paying for retrieve_skill's
// full payload — and, on stdio sessions, the tree's location (skillRoot)
// so the agent can read the same files with its own tools the way it
// explores native skills. Registry-driven on purpose (PACKS order, claimed
// skills only) rather than a tree walk: the output order is deterministic,
// every entry carries a defined pack, and the deliberate difference from
// searchDocs' ungated-straggler posture is that unclaimed directories do
// not exist here — verifySkillTree refuses to boot the server on any.
// Gating is disclosure-level on both fields' terms: catalog entries never
// reference a trimmed pack's skills, while skillRoot discloses the shared
// tree (every skill, including trimmed packs' and the six core
// meta-skills) — the same doctrine enable.ts applies to pack handlers.
// A missing SKILL.md for a claimed skill throws (readFileSync) and rides
// the callTool error pass-through: the boot guard makes hollow entries
// unreachable in a booted server (a file deleted or made unreadable after
// boot can still throw, riding the same pass-through), and fabricating
// metadata for a hollow entry would be worse than the honest crash.
function listSkills(pack: string | undefined, opts: CallToolOptions = {}) {
  const packId = String(pack ?? '').trim();
  if (pack !== undefined && packId === '') {
    return { ok: false, error: 'Pack id is required.' };
  }
  const enabled = resolveEnabledPacks();
  if (packId) {
    const found = PACKS.find((entry) => entry.id === packId);
    if (!found) return packNotFound(packId);
    if (packId === 'core') {
      return {
        ok: false,
        error:
          'The core pack\u2019s six meta-skills (huaweicloud-*) are not listed here by design: directory-loading agents disclose them natively in the system prompt, and huaweicloud_retrieve_skill serves them identically everywhere.',
      };
    }
    if (!enabled.has(found.id)) return packNotEnabled(found.id);
  }
  const skills: Array<{
    name: string;
    description: string;
    pack: string;
    version: string | number;
    references: string[];
  }> = [];
  for (const entry of PACKS) {
    if (entry.id === 'core') continue;
    if (packId && entry.id !== packId) continue;
    if (!enabled.has(entry.id)) continue;
    for (const skillName of entry.skills) {
      const fm = parseSkillFrontmatter(readFileSync(join(SKILLS_ROOT, skillName, 'SKILL.md'), 'utf8'));
      skills.push({
        name: skillName,
        description: fm.description ?? '',
        pack: entry.id,
        version: fm.version ?? 1,
        references: referenceFilenames(skillName),
      });
    }
  }
  // skillRoot rides only surfaces that carry session state (stdio), the
  // same seam listPacks uses to drop packs_configure from the remote's
  // tool inventory: the stateless remote serves an unauthenticated CORS-*
  // face whose callers cannot reach the server host's filesystem, so a
  // host path there would be pure leakage with no utility. The key itself
  // is withheld rather than nulled — absence is the guard.
  const stdioSession = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: skills.length,
    skills,
    ...(stdioSession ? { skillRoot: SKILLS_ROOT } : {}),
  };
}

// Session pack configuration. One mutation with three shapes (enable,
// disable, reset) over the override state in packs/enable.ts. The delta math
// works at the effective level (the closed enablement set), never at the raw
// requested seed: a duplicated DEVKIT_PACKS id or a closure-pulled pack must
// not turn a no-op into a stored override. The seed is joined in PACK_IDS
// order and always carries core (the base set includes it and disable cannot
// remove it), so the blank-value trap (blank means the full surface) is
// unreachable and needs no fallback branch.
function configurePacks(args: ToolArgs, opts: CallToolOptions): unknown {
  const enable = (args.enable ?? []).map((id) => String(id));
  const disable = (args.disable ?? []).map((id) => String(id));
  const reset = args.reset === true;
  if (!reset && enable.length === 0 && disable.length === 0) {
    return { ok: false, error: 'Provide at least one of enable, disable, or reset.' };
  }
  const bogus = [...enable, ...disable].filter((id) => !(PACK_IDS as readonly string[]).includes(id));
  if (bogus.length > 0) {
    return {
      ok: false,
      error: 'Unknown pack id(s): ' + bogus.join(', ') + '. Valid pack ids: ' + PACK_IDS.join(', ') + '.',
    };
  }
  if (disable.includes('core')) {
    return {
      ok: false,
      error:
        'core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled.',
    };
  }
  const overlap = enable.filter((id) => disable.includes(id));
  if (overlap.length > 0) {
    return {
      ok: false,
      error: 'Pack id(s) cannot be both enabled and disabled in one call: ' + overlap.join(', ') + '.',
    };
  }
  if (!opts.onPacksChanged) {
    return {
      ok: false,
      error:
        'Runtime pack configuration is available in stdio agent sessions only; this surface carries no session state.',
    };
  }
  const current = runtimePacksOverride();
  if (reset && (enable.length > 0 || disable.length > 0)) {
    return {
      ok: false,
      error: 'reset drops the whole session override and cannot be combined with enable or disable.',
    };
  }

  const currentEffective = resolveEnabledPacks();
  // Both lists were validated against PACK_IDS above, so the ids are PackId
  // at runtime; one narrowing here keeps the set math below typewise clean.
  const enableIds = enable as PackId[];
  const disableIds = disable as PackId[];
  const next = new Set<PackId>(currentEffective);
  for (const id of disableIds) next.delete(id);
  for (const id of enableIds) next.add(id);
  const wouldEnable = closePackEnablement(next).enabled;
  const same = wouldEnable.size === currentEffective.size && [...currentEffective].every((id) => wouldEnable.has(id));

  let changed = false;
  if (reset) {
    if (current) {
      clearRuntimePacksOverride();
      changed = true;
    }
  } else if (!same) {
    setRuntimePacksOverride(PACK_IDS.filter((id) => next.has(id)).join(','));
    changed = true;
  }
  if (changed) opts.onPacksChanged();

  const effective = resolveEnabledPacks();
  return {
    ok: true,
    changed,
    override: runtimePacksOverride()?.raw ?? null,
    effectivePacks: PACK_IDS.filter((id) => effective.has(id)),
    note: changed
      ? 'Session override active. Restarting the session restores the operator DEVKIT_PACKS posture.'
      : reset
        ? 'No session override was active.'
        : 'The requested surface already applies.',
  };
}

function explainError({ service = 'unknown', errorCode = '', message = '', requestId = '' }: ToolArgs = {}) {
  const combined = `${errorCode} ${message}`.toLowerCase();
  const suggestions: string[] = [];
  const svc = String(service).toLowerCase();

  const SERVICE_ALIASES: Record<string, string> = {
    functiongraph: 'FSS',
    fgs: 'FSS',
  };
  const patternKey = SERVICE_ALIASES[svc] || service;

  const hwErrorPatterns: Record<string, Record<string, string>> = {
    OBS: {
      InvalidAccessKeyId:
        'OBS uses AK/SK directly (not IAM tokens). Verify AK/SK validity, OBS endpoint, and OBS permissions.',
      UserRestricted:
        'This IAM user is restricted from OBS operations (403). Check IAM console → Users → Permissions: grant OBS bucket/object actions, or use an unrestricted account. If the account is a sub-account, the main account may have imposed restrictions.',
    },
    APIG: {
      'APIC.7241': 'The enterprise_project_id is required for enterprise accounts. Add --enterprise_project_id=0.',
      'APIC.7242':
        'The EIP binding method depends on loadbalancer_provider. Use AddIngressEipV2 for elb, AddEipV2 for lvs.',
      'APIC.7256': 'Bandwidth minimum is 5 Mbps. Use --bandwidth_size=5 or higher.',
      'APIC.7310': 'available_zone_ids must use AZ codes (e.g. ap-southeast-3a), NOT UUIDs from ListAvailableZonesV2.',
    },
    FSS: {
      'FSS.0403':
        'Missing FunctionGraph IAM permissions. Attach FunctionGraph FullAccess role or grant specific actions.',
      'FSS.1078': '--code_filename is filename-only (no path). cd to the file directory before running the command.',
      'FSS.1417':
        'event_data field validation failed. Check parameter format: use dotted key=value, verify required hidden-optional fields.',
    },
    VPC: {
      'VPC.0301': 'Bandwidth name is required for PER type EIPs, even though --help marks it optional.',
    },
    APIGW: {
      'APIGW.0301':
        'Incorrect IAM authentication information. The AK/SK is invalid (check the SK for typos), the security token is missing or expired, or the profile lacks project_id. Fix: re-run "npx huaweicloud-devkit auth init" (it auto-sets project_id), or set it manually: hcloud configure set --cli-project-id=<project_id> after finding it via hcloud IAM KeystoneListProjects --cli-region=<region> --name=<region>.',
      'APIGW.0802':
        'The current IAM user has no permissions in the requested region. Go to IAM console → Users → Permissions → add the target region, or switch to a different region.',
    },
  };
  if (hwErrorPatterns[patternKey] && hwErrorPatterns[patternKey][errorCode]) {
    suggestions.push(hwErrorPatterns[patternKey][errorCode]);
  }
  const svcPatterns: Record<string, string> = hwErrorPatterns[patternKey] || {};
  for (const [code, tip] of Object.entries(svcPatterns)) {
    if (errorCode && code.includes(errorCode)) {
      if (!suggestions.includes(tip)) suggestions.push(tip);
    }
  }

  if (/auth|token|credential|ak|sk|401|403|unauthorized|forbidden|Incorrect IAM/i.test(combined)) {
    if (svc === 'obs') {
      suggestions.push(
        'OBS uses AK/SK directly, not IAM tokens. Verify AK/SK validity and OBS bucket permissions via hcloud configure list or the Huawei Cloud console.',
      );
    } else {
      suggestions.push('Check KooCLI profile, region, project_id, and IAM permissions without printing secrets.');
    }
  }
  if (/APIGW\.(\d+)/i.test(errorCode)) {
    suggestions.push(
      'APIGW.' +
        (errorCode.match(/APIGW\.(\d+)/i) || [])[1] +
        ': API Gateway layer error. ' +
        (errorCode === 'APIGW.0802'
          ? 'IAM user has no region permissions — check IAM console → User → Permissions → add target region.'
          : errorCode === 'APIGW.0301'
            ? 'Incorrect IAM authentication information — verify AK/SK (SK typos are the usual cause), security token expiry, and that project_id is configured (auth init auto-sets it).'
            : 'Verify the API request, region endpoint, and IAM permissions.'),
    );
  }
  if (/region|endpoint|project/i.test(combined)) {
    suggestions.push('Confirm the service endpoint, region, and project_id match the target resource.');
  }
  if (/quota|limit|insufficient|reach the limit/i.test(combined)) {
    suggestions.push(
      'Check quota and resource limits before retrying a create or scale operation. Consider switching accounts or requesting a quota increase.',
    );
  }
  if (/not.?found|404/i.test(combined)) {
    if (/list.?regions/i.test(svc)) {
      suggestions.push('Use hcloud IAM KeystoneListRegions (not list-regions).');
    } else {
      suggestions.push('List resources in the same region/project and verify the resource identifier.');
    }
  }
  if (!suggestions.length) {
    suggestions.push(
      'No known error-code pattern matched. Re-run the failing command with --debug to capture ' +
        'X-Request-Id from the response headers, then re-call explain_error with service, operation, ' +
        'region, the full redacted message, and requestId.',
    );
    if (errorCode) {
      suggestions.push(
        `Search the error code "${errorCode}" in the Huawei Cloud error center (support.huaweicloud.com) for the authoritative cause.`,
      );
    }
  }

  if (requestId) {
    suggestions.push('Provide the Request ID (' + requestId + ') when contacting Huawei Cloud support.');
  }

  const uniqueSuggestions = suggestions.filter((s, i, arr) => {
    return !arr.slice(0, i).some((prev) => prev.substring(0, 50).toLowerCase() === s.substring(0, 50).toLowerCase());
  });

  return {
    service,
    errorCode,
    requestId,
    suggestions: uniqueSuggestions,
  };
}

async function searchDocs(query: string, topic: string = 'all') {
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  // Skills owned by a disabled pack are filtered out of the search index;
  // core-owned and unclaimed (foreign) skills stay searchable.
  const enabled = resolveEnabledPacks();
  const results: Array<{ source: string; name: string; snippet: string; relevance: number }> = [];
  try {
    if (existsSync(SKILLS_ROOT)) {
      const dirs = listSkillDirs(SKILLS_ROOT);
      for (const dir of dirs) {
        const owner = SKILL_OWNER.get(dir);
        if (owner && !enabled.has(owner)) continue;
        const skillPath = join(SKILLS_ROOT, dir, 'SKILL.md');
        if (!existsSync(skillPath)) continue;
        const content = readFileSync(skillPath, 'utf8');
        const fm = parseSkillFrontmatter(content);
        const description = fm.description ?? '';
        const name = fm.name ?? dir;
        if (topic !== 'all') {
          const topicLower = topic.toLowerCase();
          if (!name.toLowerCase().includes(topicLower) && !description.toLowerCase().includes(topicLower)) continue;
        }
        const descLower = description.toLowerCase();
        const nameLower = name.toLowerCase();
        const contentLower = content.toLowerCase();
        const relevance = tokens.reduce((score, token) => {
          return (
            score +
            (descLower.includes(token) ? 3 : 0) +
            (nameLower.includes(token) ? 2 : 0) +
            (contentLower.includes(token) ? 1 : 0)
          );
        }, 0);
        if (relevance > 0) {
          results.push({
            source: 'skills/' + dir + '/SKILL.md',
            name,
            snippet: description.substring(0, 200),
            relevance,
          });
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), results: [] };
  }
  results.sort((a, b) => b.relevance - a.relevance);
  return { ok: true, query: q, topic, count: results.length, results: results.slice(0, 10) };
}

async function retrieveSkill(name: string) {
  const skillName = String(name || '').trim();
  if (!skillName) return { ok: false, error: 'Skill name is required.' };
  // Boundary guard: the name joins a filesystem path in this handler, so
  // anything outside the skill-name shape (traversal segments, separators,
  // absolute paths) is rejected before touching disk; direct reads via the
  // disclosed skillRoot are the agent's own file tools' territory.
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    return {
      ok: false,
      error: 'Invalid skill name "' + skillName + '". Skill names are lowercase letters, digits, and dashes.',
    };
  }
  const skillPath = join(SKILLS_ROOT, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    // The Available list advertises only enabled packs' skills: recommending a
    // name the owner gate would refuse misroutes the agent.
    const enabled = resolveEnabledPacks();
    const dirs = listSkillDirs(SKILLS_ROOT).filter((dir) => {
      const owner = SKILL_OWNER.get(dir);
      return !owner || enabled.has(owner);
    });
    return { ok: false, error: 'Skill "' + skillName + '" not found. Available: ' + dirs.join(', ') };
  }
  const owner = SKILL_OWNER.get(skillName);
  if (owner && !resolveEnabledPacks().has(owner)) {
    return {
      ok: false,
      error:
        'Skill "' +
        skillName +
        '" belongs to pack "' +
        owner +
        '" which is not enabled. ' +
        packEnablementRemediation(owner),
    };
  }
  const content = readFileSync(skillPath, 'utf8');
  const references: Array<{ filename: string; content: string }> = [];
  for (const filename of referenceFilenames(skillName)) {
    const refPath = join(SKILLS_ROOT, skillName, 'references', filename);
    references.push({ filename, content: readFileSync(refPath, 'utf8').substring(0, 4000) });
  }
  const frontmatter = parseSkillFrontmatter(content);
  const version: string | number = frontmatter.version ?? 1;
  const description = frontmatter.description ?? '';
  return { ok: true, name: skillName, version, description, content, references };
}

async function getRegionalAvailability(service: string, region: string) {
  const svc = String(service || '')
    .toLowerCase()
    .trim();
  const reg = String(region || '')
    .toLowerCase()
    .trim();
  if (!svc || !reg) return { ok: false, error: 'Both service and region are required.' };
  // svc is an arbitrary string at this boundary; the explicit Record view is
  // what keeps the string index legal under strict mode (SERVICE_REGIONS is a
  // closed object literal with no index signature).
  const table: Record<string, readonly string[]> = SERVICE_REGIONS;
  if (!table[svc])
    return {
      ok: false,
      service: svc,
      region: reg,
      available: false,
      note:
        'Service ' +
        svc +
        ' is not in the regional availability cache. Run hcloud ' +
        svc.toUpperCase() +
        ' --help to verify, or check https://developer.huaweicloud.com/endpoint.',
    };
  const available = table[svc].includes(reg) || table[svc].includes('global');
  return {
    ok: true,
    service: svc,
    region: reg,
    available,
    note: available
      ? svc + ' is available in ' + reg + '.'
      : svc +
        ' availability in ' +
        reg +
        ' could not be confirmed. Verify at https://developer.huaweicloud.com/endpoint.',
    sourcedFrom: 'static cache, update via npm package upgrade',
    disclaimer:
      'This result reflects service-level availability only. It does NOT guarantee that your IAM user has permissions in this region. Account-level restrictions (e.g., APIGW.0802) may block actual API calls even when the service is available.',
  };
}

export function classifyRawCommand(command: unknown) {
  return classifyTextCommand(command);
}
