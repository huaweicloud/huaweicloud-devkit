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
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ToolName } from './tool-definitions.ts';
import type { ToolArgs, CallToolOptions } from './tools.ts';
import { approvalModeFromEnv } from './lib/approval-mode.ts';
import { createApprovalToken, consumeApprovalToken, hashArgs, inspectApprovalToken } from './lib/approval-tokens.ts';
import { huaweiConfigBase } from './lib/state-dir.ts';
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

// The credential-file hard floor (interrogate rounds 1-3): the hook
// exemption bets "the server gate is strictly stronger" for the classes it
// skips, and for the write class that bet holds (token + grant + pin-view
// binding). It did NOT hold for credential-file reads: the argv classifier
// never consults credentialFilePatterns, so an approved OBS cp of the vault
// master key or /proc/self/environ executed where the hook used to deny.
// The floor walks the binding value's string leaves, in BOTH modes, before
// any mint, consume, or consent record — so the refusal burns nothing and
// the exfil refuses even where no hook exists at all (the remote face,
// hook-less harnesses, direct callTool). Credential denies are never
// unlockable by any confirmation, the same doctrine the strict plan applies
// to secret and invalid denies.
//
// Round 2 added alias resolution; round 3 reworked both halves for trunk
// parity on benign operations:
//
//   (a) RESOLUTION, child-faithful. Every leaf that can name a local file —
//       absolute, relative, or BARE (the child resolves a bare name against
//       its cwd; skipping bare names let an innocuous symlink named 'blob'
//       ship the master key) — is resolved through realpathSync against
//       only the bases the spawned child can actually apply: the call's
//       own cwd, else the server process's cwd (spawn's default). The
//       round-2 extra bases (user home, config home) manufactured refusals
//       for files the child never sees and are gone. Tilde and $HOME
//       spellings are expanded against the real and devkit home roots
//       before resolution — expanding a path's own spelling is not a base.
//       URI-scheme leaves (obs://, http://, …) are never local paths:
//       skipped before resolution and before matching, always.
//
//   (b) MATCHING, path-semantic. Patterns apply to RESOLVED PATHS only,
//       segment-anchored — the policy regexes are substring-shaped for the
//       hook's text posture, and raw-substring matching denied a plain
//       note file (notes.huaweicloud.md), an obs:// key containing
//       huaweicloud/secrets, and a project's deploy/huaweicloud/config.yaml.
//       The segment rules below operationalize each credentialFilePattern
//       as a path reading; the hook keeps its own layer unchanged.
//
// A refusal requires a resolved path that EXISTS and hits a segment rule,
// so speculative names cannot false-deny. Honest residual, recorded: a
// target that does not exist yet at call time, or a path only reachable
// from a child cwd the gate cannot know (args.cwd unset and a wrapper
// changing the child's directory), stays uncovered.
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

// Segment rules, one per policy credentialFilePattern (each rule's comment
// names the pattern it operationalizes):
//   \.hcloud, \.huaweicloud       → a path segment STARTING with the
//                                      dot-directory spelling (.hcloud,
//                                      .huaweicloud, .hcloud-backup)
//   \.master-key                    → the vault key file itself
//   creds-import\.json              → the import file, exact name
//   /proc/(self|[0-9]+)/environ      → three consecutive segments
//   huaweicloud[/\]secrets          → a 'huaweicloud' segment directly
//                                      above a 'secrets' segment
//   hcloud[/\](config|credentials), → a 'hcloud' or 'huaweicloud' segment
//   huaweicloud[/\](config|          directly above the config/credentials
//     credentials|creds-import)      file names — suffixed names like
//                                      config.yaml are NOT the config file,
//                                      so deploy/huaweicloud/config.yaml
//                                      executes as trunk did
const CREDS_FILE_NAMES = new Set(['config', 'credentials', 'config.json', 'credentials.json', 'creds-import.json']);

function isCredentialResolvedPath(resolvedPath: string): boolean {
  const segments = resolvedPath.split('/').filter((segment) => segment.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment.startsWith('.hcloud') || segment.startsWith('.huaweicloud')) return true;
    if (segment === '.master-key' || segment === 'creds-import.json') return true;
    if (segment === 'proc' && i + 2 < segments.length) {
      const owner = segments[i + 1]!;
      const file = segments[i + 2]!;
      if ((owner === 'self' || /^\d+$/.test(owner)) && file === 'environ') return true;
    }
    const next = i + 1 < segments.length ? segments[i + 1]! : null;
    if (
      next &&
      (segment === 'huaweicloud' || segment === 'hcloud') &&
      (CREDS_FILE_NAMES.has(next) || (segment === 'huaweicloud' && next === 'secrets'))
    ) {
      return true;
    }
  }
  return false;
}

// The home roots a tilde or $HOME spelling can mean: the real home, the
// process's HOME if set, and the devkit's home root (HUAWEICLOUD_HOME —
// the config tree, and therefore the credential files, relocate with it).
function homeRootsForSpelling(): ReadonlyArray<string> {
  const configBase = huaweiConfigBase();
  const roots = [homedir(), resolve(configBase, '..', '..')];
  const envHome = process.env.HOME;
  if (typeof envHome === 'string' && envHome !== '') roots.push(envHome);
  return [...new Set(roots)];
}

function resolvedLeafCandidates(leaf: string, cwdBases: ReadonlyArray<string>): string[] {
  if (URI_SCHEME_RE.test(leaf)) return []; // a URI is never a local path
  // Edge-quote strip: the child's shell would have removed them; the round-1
  // vectors carry them.
  const stripped = leaf.replace(/^['"]|['"]$/g, '');
  const expanded: string[] = [stripped];
  if (stripped.startsWith('~')) {
    const tail = stripped.slice(1);
    for (const root of homeRootsForSpelling()) expanded.push(join(root, tail));
  } else if (/^\$\{?HOME\}?([/\\].*)?$/.test(stripped)) {
    const tail = stripped.replace(/^\$\{?HOME\}?[/\\]?/, '');
    for (const root of homeRootsForSpelling()) expanded.push(join(root, tail));
  }
  const candidates: string[] = [];
  const tryResolve = (candidate: string): void => {
    try {
      candidates.push(realpathSync(candidate));
    } catch {
      // not an existing path from this base — the next candidate speaks
    }
  };
  // Absolute spellings resolve on their own; relative and bare spellings
  // against the child's bases only.
  for (const candidate of expanded) {
    if (candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate)) tryResolve(candidate);
  }
  for (const base of cwdBases) {
    for (const candidate of expanded) {
      if (!candidate.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(candidate)) tryResolve(join(base, candidate));
    }
  }
  return candidates;
}

function firstCredentialPathIn(value: unknown, cwdBases: ReadonlyArray<string>): string | null {
  if (typeof value === 'string') {
    for (const resolved of resolvedLeafCandidates(value, cwdBases)) {
      if (isCredentialResolvedPath(resolved)) return resolved;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstCredentialPathIn(item, cwdBases);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const leaf of Object.values(value)) {
      const hit = firstCredentialPathIn(leaf, cwdBases);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// The child's working directories, in spawn order: the call's own cwd when
// set, else the server process's cwd (spawn's default) — nothing else. Any
// wider base manufactured refusals for files the child cannot see.
function credentialBases(args: ToolArgs): ReadonlyArray<string> {
  const bases = [typeof args.cwd === 'string' ? args.cwd : '', process.cwd()];
  return [...new Set(bases.filter((base): base is string => base !== ''))];
}

function assertNoCredentialPath(value: unknown, args: ToolArgs): void {
  const hit = firstCredentialPathIn(value, credentialBases(args));
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
  // needs no consent, so no mint, no ledger entry, no gate. The verdict is
  // computed once here and consulted per-branch below, and the floors run
  // BEFORE it (interrogate round 2, finding 5): a credential path in the
  // binding refuses regardless of the flavor outcome — the pass-through
  // skips consent machinery, never safety floors.
  const classifiedPass = spec.flavor === 'classified' && spec.classify?.(value, opts) === 'none';

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
    // Floors first, so a refused call is not a consent arrival; a
    // classified pass-through sits after the floors and skips only the
    // consent record.
    assertNoCredentialPath(value, args);
    spec.assertArgsExecutable?.(value, 'ask');
    if (classifiedPass) return 'pass';
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
    // gate mints nothing. The floors do not preempt this envelope — trunk
    // classified nothing on a tokenless call, and the plan face's own hook
    // deny already covers the credential class at plan time.
    if (spec.tokenSource === 'plan-face') {
      return { envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' } };
    }
    // Gate-source mint face (PR-3 registrations; ApprovalCoreMint's
    // classify-before-mint). BOTH floors sit before the mint for the same
    // reason classify does: never mint a token for a call the gate would
    // refuse (NoDoomedToken's posture, one class wider) — the round-2
    // token-mode branch ran only the credential floor, minting a token for
    // content the spec's execution floor refuses. A classified
    // pass-through skips the mint and the floors never.
    assertNoCredentialPath(value, args);
    spec.assertArgsExecutable?.(value, 'token');
    if (classifiedPass) return 'pass';
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
  assertNoCredentialPath(value, args);
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
