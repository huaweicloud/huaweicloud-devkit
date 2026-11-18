// The vendorConfirmed gate and the first-assertion challenge above it —
// cross-cutting dispatch policy, split out of tools.ts (the dispatch shell
// calls enforceVendorGate from the top of dispatchTool; the gated roster and
// the once-per-session challenge state live here).
import type { ToolName } from './tool-definitions.ts';
import type { ToolArgs, CallToolOptions } from './tools.ts';

// The vendor gate enforces the VENDOR_BOUNDARY_RULE teaching at the tool
// face. Measured failure (live probe 2026-10-23, twice-stable; post-fix
// e2e blade red): with teaching landed and disclosed, a vendor-neutral
// prompt still drove check_cli → auth_status → show_profile →
// run_readonly_command and even auth_switch persist — instructions alone
// did not change the first move. The mechanism composes two
// repo-measured consent patterns: the approvedByUser attestation (models
// are notably reluctant to falsely assert a user-context boolean —
// core-approval-negative green) and the gateway refusal teaching (the
// rejection reason itself names the two honest exits — the
// openmcp-execute-refusal-consent precedent). The gate throws instead of
// returning a structured result so the refusal rides the same channel
// the approval chain already established (callTool errors reach the model
// with their message, and the trace records ok:false — the e2e negative
// case's zero-assertion pin reads exactly that shape). Statelessness is
// deliberate: every call re-asserts, no session or cross-request state,
// so the stateless remote face is covered by construction.
//
// Scope: the MEASURED entry set (the probe/execution chain above) plus
// the sibling claim face — not every cloud-facing tool. Deliberately
// ungated, extend on measurement (never silently): gateway_call (its own
// policy engine is its consent plane — devkit does not double-gate it);
// the sandbox exec/upload/deploy faces (they take a workspace_id
// directly — NOT only behind connect — but every e2e flow reaches them
// through gated connect or a user-supplied id); the obs faces
// (setup_obs_config, obs_set_website_config), auth_sync/auth_confirm,
// sandbox check_user/sign_agreement/credentials/expose_tunnel/shutdown,
// and voucher_status (account-state probes and writers that no measured
// vendor-neutral first move has landed on); and the devkit meta tools
// (check_update, list_skills, ...) the rule exempts.
export const VENDOR_GATED_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'huaweicloud_auth_status',
  'huaweicloud_auth_init',
  'huaweicloud_auth_switch',
  'huaweicloud_check_cli',
  'huaweicloud_show_profile_redacted',
  'huaweicloud_list_operations',
  'huaweicloud_list_regions',
  'huaweicloud_run_readonly_command',
  'huaweicloud_plan_cli_command',
  'huaweicloud_run_approved_command',
  'huaweicloud_service_catalog',
  'huaweicloud_sandbox_connect',
  'huaweicloud_voucher_claim',
  'huaweicloud_competition_voucher_claim',
]);

// Both messages exceed call-trace's 300-char error cap, so the trace copy
// in devkit-trace.jsonl truncates them; the message the model receives on
// the wire is the full teaching (both honest exits), untruncated.
const VENDOR_GATE_MESSAGE =
  "Vendor gate: this tool operates on Huawei Cloud. Pass vendorConfirmed with the user's establishing words — the quote where they named Huawei Cloud, an hcloud artifact, a myhuaweicloud endpoint, a Huawei region ID, or an earlier confirmation. The devkit being installed is NOT confirmation. If you cannot quote the user, ask which cloud they mean, then retry once established.";

// First-assertion challenge, the rung above the gate. Measured basis: the
// A/B rig (2026-10-23, glm-5.2, n=5/arm, prompt 查询ECS列表) — teaching-only
// never asked (0/5, every run presumed Huawei Cloud); the gate asked 4/5,
// and the residual failure shape was a COLD fabricated assertion (1/5:
// vendorConfirmed:true with zero prior turns, live-corroborated on
// glm-5.3). The boolean is a checkbox the server cannot verify (MCP never
// sees the conversation), so the one shape left to challenge is the
// session's FIRST asserted call: it bounces once with this message — the
// decision-time interrupt the approval chain's plan→run dance measured
// models complete honestly. Granularity follows the _updateInfo precedent
// (consumedBySession): keyed on opts.sessionId, so stdio scopes it to the
// server process's session and the stateless remote to the request (every
// request's first asserted call is challenged — consistent, documented).
// HUAWEICLOUD_VENDOR_CHALLENGE=off disables the bounce for the
// deterministic test tiers (the installer-seam override pattern); the
// real-model e2e tier never sets it, and the gate itself has no off.
const VENDOR_CHALLENGE_MESSAGE =
  "Vendor challenge: first Huawei Cloud tool call this session — is the vendorConfirmed quote the user's actual words, or invented? An invented quote is a fabricated user statement. If invented, or the vendor was only assumed, ask which cloud they mean now. Retry the same call to proceed; this challenge appears once per session.";

const vendorChallengeConsumed = new Map<string, boolean>();

function vendorChallengeEnabled(): boolean {
  return process.env.HUAWEICLOUD_VENDOR_CHALLENGE !== 'off';
}

// Quote-form attestation: a non-empty quote of the user's establishing
// words (boolean true no longer passes — a quote is the lie the A/B
// residual showed models will not fabricate lightly; an empty or
// whitespace-only quote is no quote). An ASSERTED first call clears the
// gate but hits the once-per-session challenge above it — the bounce is
// consumed whether the model turns to the user or retries; either way it
// happened at the decision moment, not after the operation.
export function enforceVendorGate(args: ToolArgs, opts: CallToolOptions): void {
  const quote = args.vendorConfirmed;
  if (typeof quote !== 'string' || quote.trim().length === 0) {
    throw new Error(VENDOR_GATE_MESSAGE);
  }
  const challengeKey = opts.sessionId || 'default';
  if (vendorChallengeEnabled() && !vendorChallengeConsumed.get(challengeKey)) {
    vendorChallengeConsumed.set(challengeKey, true);
    throw new Error(VENDOR_CHALLENGE_MESSAGE);
  }
}
