// The dispatch-layer approval gate. Every roster tool's call flows through
// here AFTER the vendor gate and BEFORE pack dispatch (tools.ts), with the
// tool's ApprovalSpec resolved from the registry merge (packs/registry.ts
// APPROVAL_SPECS). The hcloud path migrated in with zero behavior change:
// its spec registers normalizeArgs (stripLeadingHcloudBinArgs) so the gate
// binds the plan's effective args exactly as the pack handler did, and
// tokenSource 'plan-face' keeps the trunk contract — the plan face is the
// only minter, so a no-token call returns CONFIRM_TOKEN_NOT_FOUND and the
// gate mints nothing (ApprovalCoreMint: GateNeverMintsForPlanFace,
// PlanFaceMintsOnlyItsOwn).
//
// A 'gate' tool (PR-3 registrations) mints on the first no-token call and
// returns USER_CONFIRMATION_REQUIRED with the fresh approvalToken and the
// redacted summarize view, executing nothing. Ask mode routes straight to
// the registered handler with no token and records the consent event in
// the ledger. requiresSessionSeam tools (packs_configure) check
// opts.onPacksChanged BEFORE engaging, mirroring the handler's own
// stdio-only refusal, so no-seam calls refuse with nothing minted and no
// ledger entry. With a token the gate runs the existing consume flow —
// single-use claim, grant verification, hash and pin-view binding — and
// the registered handler keeps only the pure execution it owns, so the
// one-snapshot TOCTOU contract stays inside consumeApprovalToken.
import type { ToolName } from './tool-definitions.ts';
import type { ToolArgs, CallToolOptions } from './tools.ts';
import { approvalModeFromEnv } from './lib/approval-mode.ts';
import { createApprovalToken, consumeApprovalToken, hashArgs, inspectApprovalToken } from './lib/approval-tokens.ts';
import { isCredentialFilePath } from './safety-policy.ts';
import { recordAskModeConsent } from './approval-ledger.ts';
import type { ApprovalSpec } from './approval-types.ts';

// The gate result: 'pass' lets dispatch continue; an envelope object is
// returned to the caller INSTEAD of the handler's value. Approval-shaped
// refusals are results, not throws, so callTool's caller (and the trace
// seam) see the same JSON shapes the pack handler returns for them.
export type ApprovalGateOutcome = 'pass' | { envelope: Record<string, unknown> };

export const NO_SESSION_SEAM_ERROR =
  'Runtime pack configuration is available in stdio agent sessions only; this surface carries no session state.';

const GRANT_REQUIRED_NEXT_STEP =
  'Ask the user to run "npx huaweicloud-devkit approve <this approvalToken>" in their own terminal, then retry this exact call.';

function bindingValue(spec: ApprovalSpec, args: ToolArgs): unknown {
  return spec.normalizeArgs ? spec.normalizeArgs(args) : args;
}

// The credential-file hard floor (interrogate round 1, finding 2): the
// hook exemption bets "the server gate is strictly stronger" for the
// classes it skips, and for the write class that bet holds (token + grant
// + pin-view binding). It did NOT hold for credential-file reads: the
// argv classifier never consults credentialFilePatterns, so an approved
// OBS cp of ~/.config/huaweicloud/secrets/.master-key or
// /proc/self/environ executed where the hook used to deny. The floor
// walks the binding value's string leaves with the same
// isCredentialFilePath the vault's file channel uses, in BOTH modes,
// before any mint, consume, or consent record — so the refusal burns
// nothing and the exfil refuses even where no hook exists at all (the
// remote face, hook-less harnesses, direct callTool). Credential denies
// are never unlockable by any confirmation, the same doctrine the strict
// plan applies to secret and invalid denies.
function firstCredentialPathIn(value: unknown): string | null {
  if (typeof value === 'string') return isCredentialFilePath(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstCredentialPathIn(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const leaf of Object.values(value)) {
      const hit = firstCredentialPathIn(leaf);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function assertNoCredentialPath(value: unknown): void {
  const hit = firstCredentialPathIn(value);
  if (hit !== null) {
    throw new Error(
      `Reading Huawei Cloud credential or profile files is blocked (argument "${hit.slice(0, 120)}"). ` +
        'Use redacted profile inspection tools instead.',
    );
  }
}

// A spec-provided classify is the grant requirement: the plan-face hcloud
// tool keeps the trunk's content-dependent gate (a read-classified command
// executes on an unconfirmed token). A registered tool with no classify
// always rides a human's grant.
function grantRequired(spec: ApprovalSpec, value: unknown, opts: CallToolOptions): boolean {
  return spec.classify ? spec.classify(value, opts) === 'required' : true;
}

export async function runApprovalGate(
  name: ToolName,
  spec: ApprovalSpec,
  args: ToolArgs,
  opts: CallToolOptions,
): Promise<ApprovalGateOutcome> {
  // Seam precheck first: packs_configure's own refusal lives inside its
  // handler, downstream of this gate, so the gate is the only place the
  // ordering rule (refuse with no token minted, no ledger entry) can be
  // enforced (ApprovalCoreMint GateMintSeam's disabled-guard posture).
  if (spec.requiresSessionSeam && !opts.onPacksChanged) {
    return { envelope: { ok: false, error: NO_SESSION_SEAM_ERROR } };
  }

  // The approvedByUser attestation precedes every gate effect, exactly as
  // it preceded the mode branch in the trunk handler: a call that fails it
  // throws before anything is minted, recorded, or consumed.
  if (args.approvedByUser !== true) {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }

  const value = bindingValue(spec, args);

  // Classified flavor engages on content: a classify that says 'none'
  // needs no consent, so no mint, no ledger entry, no gate.
  if (spec.flavor === 'classified' && spec.classify && spec.classify(value, opts) === 'none') {
    return 'pass';
  }

  const approvalMode = approvalModeFromEnv(process.env);
  if (approvalMode === 'ask') {
    // The harness client's permission prompt on this very call is the
    // user's confirmation: run the execution floors, record the arrival,
    // then route to the handler with no token. The consent event's
    // subject is the ARRIVAL, not the execution: the consent fact ("the
    // user allowed this exact call") is fully known here, while the
    // handler's outcome is a different fact the event does not claim —
    // outcome below is the consent's outcome (a call that reached the gate
    // with the attestation was allowed, hence 'granted'), the same
    // arrival semantics ApprovalCoreConsent models as the human yes.
    // Floors first, so a refused call is not a consent arrival.
    assertNoCredentialPath(value);
    spec.assertArgsExecutable?.(value, 'ask');
    recordAskModeConsent({
      sessionId: opts.sessionId ?? 'default',
      tool: name,
      argsHash: hashArgs(value),
      outcome: 'granted',
    });
    return 'pass';
  }

  const token = typeof args.approvalToken === 'string' ? args.approvalToken : '';
  if (!token) {
    // plan-face keeps the trunk contract: the plan face is the only
    // minter, so a no-token run call is a not-found rejection and the
    // gate mints nothing.
    if (spec.tokenSource === 'plan-face') {
      return { envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' } };
    }
    // Gate-source mint face (PR-3 registrations; ApprovalCoreMint's
    // classify-before-mint already ran above for the classified flavor).
    // The credential floor sits before the mint for the same reason
    // classify does: never mint a token for a call the gate would refuse
    // (NoDoomedToken's posture, one class wider).
    assertNoCredentialPath(value);
    // The token binds the effective args and the entry carries the pin
    // view the verify side compares, so the approve→run cycle completes
    // on the same binding the plan-face pair uses.
    const view = spec.summarize(value);
    const minted = createApprovalToken(value, { secretsSubstitutable: false, argsPinView: view.pinView });
    return {
      envelope: {
        status: 'rejected',
        code: 'USER_CONFIRMATION_REQUIRED',
        approvalToken: minted,
        userConfirmation: {
          needed: true,
          command: `npx huaweicloud-devkit approve ${minted}`,
          ...view,
        },
        nextStep: GRANT_REQUIRED_NEXT_STEP,
      },
    };
  }

  // With a token, the gate runs the existing lifecycle classification
  // (D4-24 precise JSON contract) on the same inspect the trunk handler
  // used, then the consume flow.
  const inspection = inspectApprovalToken(token);
  if (inspection.state === 'already_consumed') {
    return { envelope: { status: 'ok', outcome: 'already_processed' } };
  }
  if (inspection.state === 'expired') {
    return { envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' } };
  }
  if (inspection.state === 'not_found') {
    // A token that was never created (typo / unknown / pruned beyond the
    // tombstone window) is still a rejection, but carries no expired or
    // already semantics — a distinct code so clients can tell them apart.
    return { envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' } };
  }

  // Credential floor before the consume, so the refusal burns nothing and
  // the guidance stays followable on the same token; the execution floor
  // (placeholder secrets) rides the same placement for the same reason.
  assertNoCredentialPath(value);
  spec.assertArgsExecutable?.(value, 'token');

  // One snapshot: the confirmation gate, the args-hash binding, the pinView
  // fallback, and the single-use claim all read the SAME entry — the one
  // consumeApprovalToken returns (the TOCTOU contract).
  const consumed = consumeApprovalToken(token, { requireGrant: grantRequired(spec, value, opts) });
  if (consumed.status === 'grant_required') {
    return { envelope: { status: 'rejected', code: 'USER_CONFIRMATION_REQUIRED', nextStep: GRANT_REQUIRED_NEXT_STEP } };
  }
  if (consumed.status === 'gone') {
    // Defensive: inspectApprovalToken said 'valid' but consume returned
    // gone — the O_EXCL claim losing a race or a store swap between the
    // two reads. Classify via re-inspect, never a misleading success and
    // never a false not_found.
    const recheck = inspectApprovalToken(token);
    if (recheck.state === 'expired') return { envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' } };
    return { envelope: { status: 'ok', outcome: 'already_processed' } };
  }

  const stored = consumed.entry;
  const view = spec.summarize(value);
  if (view.argsHash !== stored.argsHash) {
    // The pin view is the canonical fold for the substitution comparison:
    // pre-schema entries (no argsPinView) fall back to the redactor form.
    const storedView = JSON.stringify(stored.argsPinView ?? stored.argsRedacted);
    const providedView = JSON.stringify(view.pinView);
    if (storedView !== providedView) {
      throw new Error(
        'Provided args do not match the approved plan. Use the exact args from the plan. ' +
          'If the plan shows <redacted> for passwords or secrets, replace <redacted> with the actual values.',
      );
    }
    // Views equal means ONLY secret values differ. The plan carried real
    // (non-placeholder) secrets → they are pinned: a different real secret
    // rejects. A placeholder-bearing plan (secretsSubstitutable) keeps the
    // documented substitution flow.
    if (stored.secretsSubstitutable !== true) {
      throw new Error(
        'Secret values are pinned to the approved plan: re-run huaweicloud_plan_cli_command with the final values and re-approve.',
      );
    }
  }

  // The token spent and the binding verified: the registered handler runs
  // the pure execution it owns.
  return 'pass';
}
