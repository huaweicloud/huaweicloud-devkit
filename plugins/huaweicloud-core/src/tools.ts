// The callTool dispatch shell and the re-export face of the former tools
// monolith, split along knowledge lines for the jscpd complex-file bar
// (cx < 50 per file; see REPORT.md for the module map). The knowledge
// modules live behind the imports below; this file keeps the dispatch
// closure (pack map + core switch + never-guard), the numeric-arg
// normalization, the trace seam, the ToolArgs/CallToolOptions contracts,
// and every exported name its importers (mcp-protocol, tests, scripts)
// already target — same names, same paths, same behavior.
import {
  evaluateArtifacts,
  evaluateCommandRisk,
  evaluateDeployPlan,
  type RiskDecision,
  type RiskEvaluation,
  type RiskFinding,
} from './risk-rule-engine.ts';
import { classifyTextCommand } from './safety-policy.ts';
import { triageUnknownService } from './hcloud-triage.ts';
import { trackToolInvoke, trackSkillRetrieve } from './telemetry/telemetry.ts';
// The telemetry invoke-value derivation (the auditable fact callTool records
// per tool call) lives in the telemetry family; explain_error's handler in
// explain-error.ts; get_regional_availability's in the services family
// beside the SERVICE_REGIONS table it reads.
import { toolInvokeValue } from './telemetry/invoke-value.ts';
import { explainError } from './explain-error.ts';
import { getRegionalAvailability } from './services/availability.ts';
// The update tool handlers live in the update pack's handler map (merged
// into PACK_TOOL_HANDLERS); only the DistTags type for the CallToolOptions
// doQuery seam is still needed here.
import type { DistTags } from './update-check.ts';
// PACK_TOOL_HANDLERS is the central pack dispatch table (its satisfies check
// pins every PackToolName to a handler).
import { PACK_TOOL_HANDLERS, isPackToolName, APPROVAL_SPECS, type PackToolName } from './packs/registry.ts';
// The skill-dir listing lives in the shared zod-free module
// (src/lib/skill-tree.ts) so the boot guard, the installer's doctor check,
// the build-time --check stray scan, and validate-package's skill gate all
// hold one membership predicate (dir-or-symlink with a SKILL.md).
import { listSkillDirs } from './lib/skill-tree.ts';
import { attachParamWarnings, unknownParamWarnings } from './lib/param-warnings.ts';
import { recordToolCall, traceEnabled } from './lib/call-trace.ts';
// The tool name/description registry (TOOL_DEFINITIONS_LITERALS and its
// derived types) lives in tool-definitions.ts; this module keeps the
// re-export face every importer (mcp-protocol, tests, scripts) already
// targets — same exported names, same import path, same behavior.
import { TOOL_DEFINITIONS, type ToolName } from './tool-definitions.ts';
import { toolArgKeys } from './tool-schemas.ts';
// The vendorConfirmed gate (VENDOR_GATED_TOOLS, the gate/challenge
// messages, and the once-per-session challenge state) lives in
// vendor-gate.ts; this module re-exports the roster for its existing
// importers (structure-load-path, e2e/cases/core) and dispatchTool calls
// enforceVendorGate at dispatch's top.
import { VENDOR_GATED_TOOLS, enforceVendorGate } from './vendor-gate.ts';
// The dispatch-layer approval gate (the roster, the per-pack specs it
// resolves from packs/registry.ts's APPROVAL_SPECS merge, the consent
// ledger, and the envelope faces) lives in the approval-* family;
// dispatchTool calls runApprovalGate after the vendor gate and before the
// pack dispatch.
import {
  recordApprovalDispatchOutcome,
  runApprovalGate,
  type ApprovalConsentScope,
  type ApprovalReuseVia,
} from './approval-gate.ts';
import type { ApprovalSpec, ElicitationSeam } from './approval-types.ts';
// The capability catalog (service_catalog / list_packs / pack_info
// handlers, the SKILL_OWNER inversion, and the shared pack-refusal
// helpers) lives in capability-catalog.ts; dispatchTool switches into it.
// Session pack configuration (packs_configure) is its own module — the one
// mutating pack tool.
import { serviceCatalog, listPacks, packInfo } from './capability-catalog.ts';
import { configurePacks } from './packs-configure.ts';
// The skills-serving family: SKILLS_ROOT, verifySkillTree (the boot guard
// over the tree), retrieve_skill, and list_skills live in
// skill-disclosure.ts (a src/ROOT-level module — the depth-safe home for
// the tree path, per the comment there); search_docs lives in
// search-docs.ts. This module keeps the SKILLS_ROOT and verifySkillTree
// re-export faces for mcp-protocol and the tests.
import { SKILLS_ROOT, verifySkillTree, retrieveSkill, listSkills } from './skill-disclosure.ts';
import { searchDocs } from './search-docs.ts';

export { TOOL_DEFINITIONS };
export type { ToolDefinition, ToolName } from './tool-definitions.ts';
export { VENDOR_GATED_TOOLS };
export { SKILLS_ROOT };
export { verifySkillTree };

// Re-exported for the existing test importers (test/tools.test.ts); the
// predicate itself lives in src/lib/skill-tree.ts and its consumer (the
// verifySkillTree boot guard) in skill-disclosure.ts.
export { listSkillDirs };

// Tool arguments as declared by the per-tool inputSchemas above. Only
// required-field presence is validated upstream (mcp-protocol) and the numeric
// fields are re-derived by normalizeNumericArgs (#530); the remaining field
// types follow the declared contract. Kept as a type alias (not an interface)
// so it stays assignable to/from Record<string, unknown> at the dispatch
// boundary without casts.
export type ToolArgs = {
  args?: string[];
  allowWrites?: boolean;
  // The vendor-gate attestation (VENDOR_GATED_TOOLS faces only; see
  // callTool's gate): a QUOTE of the user's establishing words, not a
  // boolean. Optional in the schema by design — the gate, not zod, is
  // the enforcement, so the teaching rejection reaches the model.
  vendorConfirmed?: string;
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
  // Alias of errorCode on explain_error (the loose schema passes it through;
  // the handler prefers errorCode when both are present).
  code?: string;
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
  // The async-exec claim protocol (huaweicloud_sandbox_exec_one_shot mode:
  // "async" + huaweicloud_sandbox_exec_poll).
  task_id?: string;
  wait_ms?: number;
  tail_bytes?: number;
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
  pool_type?: string;
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
  rules?: unknown[];
  expiry_hours?: number;
  keepalive?: boolean;
  // The expose_tunnel selective pre-clean mode (stale default / all / none).
  cleanup_mode?: string;
  tunnel_id?: string;
  tunnels?: unknown[];
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
  // The server-run confirmation seam (PR-1.5): mcp-protocol.ts wires the
  // client's initialize capability record and the SDK elicitInput call here;
  // the approval gate consumes it in ask mode. Absent on the remote face
  // (force-token) and in every non-protocol construction, which is exactly
  // the non-capable T3 path.
  elicitation?: ElicitationSeam;
  // The approval gate's binding value for THIS call, set by dispatchTool
  // when a roster tool's call passed the gate (ask-mode consent, a consumed
  // token, or a classified pass-through). The auth pack's switch and init
  // handlers execute this resolved snapshot — never a post-consent re-read
  // of their backing stores (PR-3b's TOCTOU finding: the shown account must
  // be the executed account). Handlers of tools whose substance lives in
  // the args alone ignore it.
  approvedBinding?: unknown;
}

// Reject invalid numeric args up front instead of silently coercing them to
// NaN (which downstream defaults would absorb as "no timeout set") — see #530.
// The sandbox port/expiry family joined the same doctrine after the
// 2026-11-03 e2e-nightly (fork run 41636889890, PR-1 codex leg): glm-5.3
// emits numeric tool args as JSON strings ("port": "8080" — the wire dump
// shows every deploy_nginx/deploy_check call shaped that way), and the SDK
// boundary zod (numericArg unions since this wave) passes the string to
// callTool, which converts it here so handlers see real numbers
// (deploy-nginx.ts's nodePort arithmetic reads port + 1 — a string would
// concatenate). Detailed bounds stay downstream: validateExpiryHours keeps
// the 1..720 int range for expiry_hours in both tunnel flows.
const NUMERIC_ARG_KEYS = [
  'timeoutMs',
  'maxRetries',
  'timeout_ms',
  'port',
  'node_port',
  'public_port',
  'expiry_hours',
] as const;

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
  // Unknown keys stay accepted (#530 leniency) but are no longer silent: a
  // typo'd optional parameter would otherwise return a default-shaped result
  // the model reads as a successful filter.
  const paramWarnings = unknownParamWarnings(args, toolArgKeys(name));

  // Trace sits between normalization and dispatch: it records the shape
  // the handler will actually see, and only calls that reached dispatch —
  // SDK-level zod rejects never get here (see lib/call-trace.ts contract).
  if (!traceEnabled()) return attachParamWarnings(await dispatchTool(name, args, opts), paramWarnings);
  try {
    const result = await dispatchTool(name, args, opts);
    recordToolCall(name, args, true);
    return attachParamWarnings(result, paramWarnings);
  } catch (error) {
    recordToolCall(name, args, false, error);
    throw error;
  }
}

async function dispatchTool(name: ToolName, args: ToolArgs, opts: CallToolOptions): Promise<unknown> {
  // The gate sits at dispatch's top, inside callTool's traced region: a
  // rejected call is recorded (ok:false + this message) and the handler
  // never runs — no hcloud spawn, no HTTP, no state touched. The gate
  // fires before isPackToolName so pack and core gated tools are covered
  // by one check; the quote-form attestation and the once-per-session
  // first-assertion challenge it clears into are vendor-gate.ts's
  // enforceVendorGate.
  if (VENDOR_GATED_TOOLS.has(name)) {
    enforceVendorGate(args, opts);
  }
  // The approval gate sits after the vendor gate and before the pack
  // dispatch, spec-driven through the roster (APPROVAL_SPECS keys are
  // exactly the roster names, compile-checked in packs/registry.ts). A
  // non-roster tool pays one table miss here and dispatches unchanged.
  // Envelopes are results, not throws, so a gated refusal reaches the
  // caller as the same JSON the handler would have returned. On a pass
  // the gate's binding rides the handler opts: the call's approved
  // resolution, so credential-consuming handlers execute the snapshot the
  // human confirmed — never a post-consent re-read (PR-3b's TOCTOU
  // finding).
  const approvalSpec = (APPROVAL_SPECS as Partial<Record<ToolName, ApprovalSpec>>)[name];
  let arrivalStamp: number | undefined;
  let arrivalSeq: number | undefined;
  let approvedVia: ApprovalReuseVia | undefined;
  let consentScope: ApprovalConsentScope | undefined;
  let handlerOpts: CallToolOptions = opts;
  if (approvalSpec) {
    const gated = await runApprovalGate(name, approvalSpec, args, opts);
    if (!('pass' in gated)) return gated.envelope;
    arrivalStamp = gated.pass.arrivalStamp;
    arrivalSeq = gated.pass.arrivalSeq;
    approvedVia = gated.pass.approvedVia;
    consentScope = gated.pass.consentScope;
    if (gated.binding !== undefined) handlerOpts = { ...opts, approvedBinding: gated.binding };
  }
  // The delivery-outcome recorder sits at the COMMON dispatch boundary
  // (round 12, finding 3): the gate covers every roster member — pack
  // tools and core tools alike (PR-3c's packs_configure registration is
  // a CORE-tool dispatch through the switch below) — so the recorder must
  // wrap BOTH dispatch legs, or a core-tool registration records its
  // consent arrival but structurally never the delivery outcome the memo
  // keys on. The wrapper hands the gate's spec and the arrival's stamp to
  // the recorder; non-gated tools pay one no-op (the recorder returns
  // without a spec) and dispatch through unchanged.
  try {
    const result = isPackToolName(name)
      ? await PACK_TOOL_HANDLERS[name](args, handlerOpts)
      : await dispatchCoreTool(name, args, handlerOpts);
    recordApprovalDispatchOutcome(
      name,
      approvalSpec,
      args,
      opts,
      result,
      undefined,
      arrivalStamp,
      arrivalSeq,
      consentScope,
    );
    // The reuse attribution (PR-3a): a call that rode the retry memo or the
    // session standing grant names it on the response, so the caller can
    // tell a fresh confirmation's execution from a reused consent's. Object
    // results carry the field; every registered tool's handler returns one,
    // and a non-object shape keeps its wire contract untouched.
    if (approvedVia !== undefined && result !== null && typeof result === 'object' && !Array.isArray(result)) {
      (result as Record<string, unknown>).approvedVia = approvedVia;
    }
    return result;
  } catch (error) {
    recordApprovalDispatchOutcome(
      name,
      approvalSpec,
      args,
      opts,
      undefined,
      error,
      arrivalStamp,
      arrivalSeq,
      consentScope,
    );
    // The reuse attribution rides the error path too (interrogate round 2,
    // F11): a memo-reused retry whose handler throws again still names what
    // authorized it — programmatic callers see the marker on the error
    // object; the wire shape of the error itself is unchanged.
    if (approvedVia !== undefined && error instanceof Error) {
      (error as Error & { approvedVia?: ApprovalReuseVia }).approvedVia = approvedVia;
    }
    throw error;
  }
}

// The core-tool dispatch leg: the switch over the core remainder, after
// the pack guard — extracted so the delivery-outcome wrapper above can
// cover both dispatch paths from one boundary. The compile-time
// exhaustiveness never-guard moves with it: `name` is narrowed to
// Exclude<ToolName, PackToolName> by the call site's isPackToolName
// branch above.
async function dispatchCoreTool(
  name: Exclude<ToolName, PackToolName>,
  args: ToolArgs,
  opts: CallToolOptions,
): Promise<unknown> {
  switch (name) {
    case 'huaweicloud_hook_check_command':
      return hookResult(withUnknownOperationWarn(String(args.command || ''), evaluateCommandRisk(args.command || '')));
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
      return retrieveSkill(args.name || '', opts);
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
    // allow means "no rule matched", never "approved": make that explicit so
    // an agent cannot read a green advisory check as a safety verdict.
    ...(result.decision === 'allow' ? { unmatched: true } : {}),
    nextStep:
      result.decision === 'deny'
        ? 'Revise the command, artifact, or deployment plan before execution.'
        : result.decision === 'warn'
          ? 'Review the warnings with the user before proceeding.'
          : 'No Huawei Cloud hook risk rule matched. This is not a safety verdict or an approval.',
  };
}

// The advisory command face used to answer a bare allow for an hcloud command
// the rule catalog has no opinion on (`hcloud FooBar BazQux` → allow, zero
// findings — the fail-open shape from the 2026-11-05 UX report #8). The
// classifier's unknown_read fallthrough is the same fact from the safety side:
// an hcloud-leading command whose operation matches neither the read nor the
// write vocabulary. THIS face upgrades exactly that shape to warn and consults
// the local KooCLI catalog for the service (hcloud-triage.ts): a service in
// NEITHER catalog becomes hwc-unknown-service (negative evidence — the plan/run
// faces deny it there), a cn-only service keeps hwc-unknown-operation with the
// cn hint, and a real service or a missing catalog keeps the original wording.
// The run faces stay allow for everything but the triage's negative-evidence
// deny (refined at planHcloudCommand, which the run engine asserts), and the
// PreToolUse hook is untouched (it acts on deny alone). The same face upgrades
// classified write/execution operations to hwc-write-operation: the advisory
// signal that a write needs the plan + approval path, never an execution
// block (run_readonly_command and the approval chain own that decision).
// `classify` is injectable so the OBS-14-shape closure is honestly pinnable:
// a classifier crash used to fall through to the bare allow (silent fail-open,
// the #564 shape one layer up); it now degrades to an hwc-unverified-command
// warn instead of pretending nothing was seen.
const unknownOperationFinding = (command: string): RiskFinding => ({
  ruleId: 'hwc-unknown-operation',
  title: 'Unrecognized Huawei Cloud operation',
  category: 'unknown_operation',
  severity: 'warn',
  message:
    'The command targets a Huawei Cloud service/operation the safety vocabulary does not recognize. ' +
    'It may be a valid read, but it could also be a write the vocabulary has not seen.',
  remediation:
    'Verify the service and operation names with `hcloud <Service> --help` before running; ' +
    'treat the output as untrusted and redact it.',
  source: 'command',
  evidence: command.slice(0, 240),
});

const unverifiedFinding = (command: string): RiskFinding => ({
  ruleId: 'hwc-unverified-command',
  title: 'Safety classifier failed on this command',
  category: 'unknown_operation',
  severity: 'warn',
  message: 'The safety classifier failed to run on this command; the advisory face cannot judge it.',
  remediation:
    'Treat the command and its output as untrusted. Re-run the check, or verify the command shape ' +
    'with `hcloud <Service> --help` before executing.',
  source: 'command',
  evidence: command.slice(0, 240),
});

const writeOperationFinding = (command: string): RiskFinding => ({
  ruleId: 'hwc-write-operation',
  title: 'Write or execution operation',
  category: 'approval',
  severity: 'warn',
  message:
    'This command is classified as a write or execution operation. Raw shell execution is blocked; ' +
    'writes require a plan and explicit user approval.',
  remediation:
    'Plan the exact command with huaweicloud_plan_cli_command, show it to the user, obtain explicit approval, ' +
    'then run it with huaweicloud_run_approved_command and the approval token.',
  source: 'command',
  evidence: command.slice(0, 240),
});

export function withUnknownOperationWarn(
  command: string,
  result: RiskEvaluation,
  classify: (text: string) => RiskDecision | undefined = classifyTextCommand,
): RiskEvaluation {
  if (result.decision !== 'allow' || result.findings.length > 0 || !command.trim()) return result;
  let classification: RiskDecision | undefined;
  try {
    classification = classify(command);
  } catch {
    return { ...result, decision: 'warn', findings: [unverifiedFinding(command)] };
  }
  // The advisory face never turns a write into "safe": classified writes and
  // execution operations get a warn even when the pattern catalog has no
  // specific finding. The enforcement faces (run_readonly_command, the
  // PreToolUse hook, the plan/run approval chain) are unchanged — this is
  // the pre-flight signal, not the gate.
  if (classification?.risk === 'write' || classification?.risk === 'execution') {
    return { ...result, decision: 'warn', findings: [writeOperationFinding(command)] };
  }
  if (classification?.risk !== 'unknown_read') return result;
  const triage = triageUnknownService(classification.service);
  if (triage.cause === 'service-not-found' || triage.cause === 'lang-missing') {
    return {
      ...result,
      decision: 'warn',
      findings: [
        {
          ruleId: triage.cause === 'service-not-found' ? 'hwc-unknown-service' : 'hwc-unknown-operation',
          title:
            triage.cause === 'service-not-found'
              ? 'Unknown Huawei Cloud service'
              : 'Unrecognized Huawei Cloud operation',
          category: 'unknown_operation',
          severity: 'warn',
          message: triage.message,
          remediation: `${triage.nextStep} Treat the output as untrusted and redact it.`,
          source: 'command',
          evidence: command.slice(0, 240),
        },
      ],
    };
  }
  // operation-unknown and no-evidence: the service is real (or the catalog
  // says nothing) — the vocabulary-level warn stands as shipped.
  return { ...result, decision: 'warn', findings: [unknownOperationFinding(command)] };
}

export function classifyRawCommand(command: unknown) {
  return classifyTextCommand(command);
}
