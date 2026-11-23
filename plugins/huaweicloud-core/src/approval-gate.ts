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
import { annotateDispatchOutcome, recordAskModeConsent } from './approval-ledger.ts';
import type {
  ApprovalSpec,
  ConsentDeliveryOutcome,
  ElicitFormRequest,
  ElicitFormSchema,
  ElicitOutcome,
} from './approval-types.ts';
import { resolveConfirmLanguage, type ConfirmLanguage } from './lib/confirm-language.ts';

// The gate result: a structured pass carries the arrival's identity (the
// consent stamp AND the seq the ask branch just wrote — round 15, finding
// 2) to the dispatch layer, which hands it to the delivery recorder — the
// ownership-by-identity requirement (never by position or absence) — and,
// from PR-3a, the REUSE attribution: 'retry-uncertain' when a
// byte-identical repeat rode the S1 retry memo, 'standing-session' when an
// identical call rode the S3 standing grant the user ticked. The dispatch
// layer attaches the carrier to the handler's result so the response names
// what authorized it. The pass ALSO carries the APPROVED BINDING (the
// spec's normalizeArgs value for this call, the resolved snapshot a
// credential-consuming handler must execute — never a post-consent re-read
// of its backing stores; PR-3b's TOCTOU finding); an envelope
// object is returned to the caller INSTEAD of the handler's value.
// Approval-shaped refusals are results, not throws, so callTool's caller
// (and the trace seam) see the same JSON shapes the pack handler returns
// for them.
export type ApprovalReuseVia = 'retry-uncertain' | 'standing-session';

// The consent row's scope for the arrival the pass represents, threaded to
// the dispatch recorder: 'once' for fresh confirmations and memo reuses
// (the memo keys on these arrivals' delivery outcome), 'session' for the
// standing-consent tick (a scope-'session' grant must never arm the retry
// memo), absent for standing rides (no row was written).
export type ApprovalConsentScope = 'once' | 'session';

export type ApprovalGateOutcome =
  | {
      pass: {
        arrivalStamp?: number;
        arrivalSeq?: number;
        approvedVia?: ApprovalReuseVia;
        consentScope?: ApprovalConsentScope;
      };
      // The APPROVED BINDING (the spec's normalizeArgs value for this call,
      // the resolved snapshot a credential-consuming handler must execute —
      // never a post-consent re-read of its backing stores; PR-3b's TOCTOU
      // finding). Undefined only for an envelope path, which never passes.
      binding: unknown;
    }
  | { envelope: Record<string, unknown> };

export const NO_SESSION_SEAM_ERROR =
  'Runtime pack configuration is available in stdio agent sessions only; this surface carries no session state.';

const GRANT_REQUIRED_NEXT_STEP =
  'Ask the user to run "npx huaweicloud-devkit approve <this approvalToken>" in their own terminal, then retry this exact call.';

// F-APV-1: every CONFIRM_TOKEN_* rejection spells its way out — the ask
// envelope and the mint envelope already carry nextStep, and these close the
// gap so the model never has to reverse-engineer the approval flow from
// tool descriptions. Splitting NOT_FOUND into MISSING vs INVALID is a
// contract change held for its own pass; this keeps the pinned codes and
// only adds the guidance. Exported for the tests that pin the envelopes.
export const PLAN_FACE_TOKEN_MISSING_NEXT_STEP =
  'This run call requires an approvalToken minted by the plan face. Call huaweicloud_plan_cli_command with the same args first — its USER_CONFIRMATION_REQUIRED envelope carries the fresh approvalToken; retry this call with it.';

export const CONFIRM_TOKEN_UNKNOWN_NEXT_STEP =
  'This approvalToken was never minted in this process — malformed, or dropped by a server restart (tokens are process-scoped and never persisted). Re-run the plan call to mint a fresh approvalToken, then retry this call with it.';

export const CONFIRM_TOKEN_EXPIRED_NEXT_STEP =
  'This approvalToken passed its 5-minute TTL. Re-run the plan call to mint a fresh approvalToken and have the user approve it promptly, then retry this call with it.';

// The command-forward anchor (the operator-approved display field): a call
// that carries the tool's `command` string must spell the exact line its args
// execute, so the harness popup's first line is the command the user is
// approving rather than a JSON args blob with self-attestation fields beside
// it. The check runs in BOTH modes, before any mint, consent record, or
// execution: a line that disagrees with the args is never what the user saw,
// so nothing may run. The legacy args-only shape carries no field and is
// untouched (the trunk battery drives exactly that shape), and a tool with no
// executable line ignores the field.
export const COMMAND_ARGS_MISMATCH = 'COMMAND_ARGS_MISMATCH';
export const COMMAND_REQUIRES_ARGS = 'COMMAND_REQUIRES_ARGS';

function commandAnchorRefusal(spec: ApprovalSpec, value: unknown, provided: unknown): Record<string, unknown> | null {
  if (provided === undefined) return null; // the legacy args-only shape
  // The refusal envelope's shared content: the REAL summarize view, so the
  // confirmation surface can only ever carry real content (interrogate
  // round 2, fix-in-pass iv) — never a fabricated display line.
  const noAnchorRefusal = (reason: string): Record<string, unknown> => {
    const view = spec.summarize(value);
    return {
      status: 'rejected',
      code: COMMAND_ARGS_MISMATCH,
      reason,
      summary: view.summary,
      nextStep: 'Remove the command field. This tool\u2019s confirmation view is its summarized request.',
    };
  };
  // A tool that declares no anchorable line refuses a `command` field
  // outright (the serial landing's no-anchor refusal): the field exists to
  // carry the line the user reads, and on a no-anchor tool it is a stuffed
  // display field — the exec faces, which DO anchor their own command, and
  // the structured faces behave as their registrations say.
  if (spec.commandAnchor === undefined) {
    return noAnchorRefusal(
      'this tool declares no displayable command line, so a command field is not accepted for it.',
    );
  }
  const expected = spec.commandAnchor(value);
  if (expected.length === 0) {
    // This call declares no executable line even though the spec anchors:
    // a provided one is a fabricated display line the user would read as
    // "the approved command" while the real request executes underneath.
    return noAnchorRefusal(
      'this tool takes no command field for this call: it has no executable line to anchor, and a fabricated line must never display as the approved content.',
    );
  }
  if (typeof provided !== 'string' || provided.trim() === '') {
    return {
      status: 'rejected',
      code: COMMAND_ARGS_MISMATCH,
      reason: 'the command field must be the full command line, as a non-empty string.',
      nextStep: 'Send command as the exact line the args execute, or omit it for the legacy args-only shape.',
    };
  }
  // The args-display shape (the run face): the command field anchors an
  // ARGS call, so an EMPTY args array cannot carry it. Self-anchored
  // registrations (the sandbox exec faces, whose binding is the object
  // carrying the command content itself) never take this check — their
  // anchor derives from the binding, not from an argv beside it, and their
  // object binding is not the args-array display shape at all.
  if (Array.isArray(value) && value.length === 0) {
    return {
      status: 'rejected',
      code: COMMAND_REQUIRES_ARGS,
      reason: `the command field is the display anchor for an args call and cannot stand alone (got "${provided.slice(0, 200)}").`,
      nextStep: 'Send the args array together with the matching command line, or omit command entirely.',
    };
  }
  if (!expected.includes(provided)) {
    return {
      status: 'rejected',
      code: COMMAND_ARGS_MISMATCH,
      reason:
        `the command field does not match the requested args (got "${provided.slice(0, 200)}"). ` +
        'The line the user reads in the popup must be the line that executes.',
      expected,
      nextStep:
        "Send the exact command line: the plan result's command field, or the args array spelled out. " +
        'Substitute real values where the plan shows <redacted>.',
    };
  }
  return null;
}

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
//
//   (a2) SCHEME-SPELLING, precise (interrogate round 4). obs:// is the one
//       documented cloud-object key an hcloud operand carries — those stay
//       skipped. Every OTHER scheme-shaped leaf is ALSO resolved as a
//       potential local path: obsutil treats any non-obs:// operand as a
//       LOCAL file, and POSIX collapses the double slash, so s3://x IS the
//       relative path ./s3:/x — the real KooCLI normalized s3://k to
//       childdir/s3:/k and read the credential file (round 4's live
//       dry-run). A scheme spelling that resolves to an existing local
//       file is a local operand and hits the floor; one that resolves to
//       nothing stays clean.
//
//   (a3) '='-EMBEDDED VALUES (interrogate round 4). The child dereferences
//       the VALUE half of an =-shaped leaf — KooCLI's own --param=value
//       syntax; -config=<alias> and --cli-jsonInput=<relative path> read
//       the file the bare spelling of the same value refuses. Every
//       =-shaped leaf contributes its post-'=' value as a second spelling,
//       resolved with the same rules; a value that resolves to no existing
//       file stays clean (--server.id=i-123 keeps executing).
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
// obs:// — lowercase exactly — is the documented cloud-object key scheme
// (interrogate round 5, both seats: the real KooCLI's own scheme match is
// case-sensitive; Obs:// and OBS:// operands are LOCAL paths it lstats and
// reads, measured live — `Error: lstat …/Obs:/no-such-twin` for the case
// variants against a cloud-style error for lowercase). Case-variant
// scheme spellings flow into local-path resolution like s3:// does.
const OBS_URI_RE = /^obs:\/\//;

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

export function isCredentialResolvedPath(resolvedPath: string): boolean {
  // Compare in the filesystem's own case and split on BOTH separators.
  //
  // The split: win32 realpathSync returns backslash-separated paths, so a
  // '/'-only split matched no segment rule there and the floor never
  // refused on Windows (the PR-2.5 CI finding, fixed here). The resolution
  // half above already speaks both spellings — its absolute candidate test
  // accepts drive-letter forms with either separator on every platform —
  // and this split reuses the same [\\/] vocabulary, one seam rather than
  // a second win32 spelling of the rule.
  //
  // The lowercasing (the root-reproduced finding this round): NTFS is
  // case-insensitive, so an attacker's upper-case spelling
  // (.CONFIG\HUAWEICLOUD\SECRETS\.MASTER-KEY) resolves to the real
  // credential file, while Node's non-native realpathSync preserves the
  // caller's spelling instead of the on-disk one — a case-sensitive
  // comparison then reads the attacker's spelling as a clean path and the
  // floor refuses nothing. Lowercasing closes exactly that case-variant
  // alias class and aligns the floor with the hook face's case-insensitive
  // regex doctrine (policy patterns match with the 'i' flag). Trailing-dot
  // and 8.3 short-name aliases ride the same spelling-preservation
  // mechanism but are NOT normalized here — recorded residuals: they
  // defeat the exact-name segment rules where one is the sole coverage,
  // while the prefix rules (startsWith) and the vault tree's
  // huaweicloud/secrets pair still cover the practical vault-key
  // spellings. Pinned as non-matches in the driver battery.
  //
  // Drift direction, both changes: the floor only ever ADDS matches. On
  // win32 a filename can contain neither a backslash nor (post-lowercase)
  // a case distinction against the canonical tree, so every added match is
  // a real credential path the floor was missing; on POSIX a distinct file
  // whose name lowercases or backslash-splits onto a rule shape
  // ('hcloud\credentials' as one name, a real 'HCloud/config' directory)
  // picks up one extra refusal — the documented safe direction for a
  // security floor, and the exhaustive direction probe over the alias
  // enumeration confirms zero matches lost.
  const segments = resolvedPath
    .toLowerCase()
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0);
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

// schemeSkip marks a WHOLE leaf: an obs:// operand on the OBS commands is
// a cloud object key, never a local file. An =-value spelling is NEVER
// scheme-skipped (interrogate round 5, shape 2): the child dereferences
// that channel as a file path regardless of the value's scheme spelling —
// --cli-jsonInput=obs://probe.json opens cwd/obs:/probe.json, measured
// live — so the value always resolves and refuses only when it resolves
// to an existing credential file.
function resolvedLeafCandidates(leaf: string, cwdBases: ReadonlyArray<string>, schemeSkip: boolean): string[] {
  if (schemeSkip && OBS_URI_RE.test(leaf)) return []; // a cloud object key, never a local path
  if (leaf === '') return []; // an empty spelling names no file the child can dereference
  // Any other scheme-shaped leaf still resolves below as a potential LOCAL
  // relative path: POSIX collapses the double slash, so join(base, 's3://k')
  // is base/s3:/k — exactly the local file the child opens.
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
    if (value === '') return null; // a bare empty leaf dereferences nothing
    // The whole leaf (scheme-skippable as a cloud operand), plus the VALUE
    // half of an =-shaped leaf (rule a3) — the child splits on the first
    // '=' and dereferences the value as a file path, so the value spelling
    // is never scheme-skipped and never empty: an empty value is rejected
    // by the child at parse level ([USE_ERROR] must be --param=value), it
    // cannot name a file, and resolving it to the base directory would
    // manufacture refusals (interrogate round 5, finding 3).
    const eq = value.indexOf('=');
    const valuePart = eq >= 0 ? value.slice(eq + 1) : null;
    const spellings: Array<[string, boolean]> = [[value, true]];
    if (valuePart !== null && valuePart !== '') spellings.push([valuePart, false]);
    for (const [spelling, schemeSkip] of spellings) {
      for (const resolved of resolvedLeafCandidates(spelling, cwdBases, schemeSkip)) {
        if (isCredentialResolvedPath(resolved)) return resolved;
      }
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

// The T3 envelope binding (interrogate round 2, finding 4): the chat
// round-trip is the only tier where the line the user reads and the line the
// gate executes are two messages, so the envelope's argsHash must be the
// binding, not a decoration. Every envelope emission records
// (session, tool, argsHash -> shownAt); an attested ask arrival executes only
// when its OWN argsHash has a live record. A drifted retry (different args)
// and a pre-attested first call (no record at all) both get the envelope for
// the line they are asking about, so the ritual always precedes the
// execution. TTL-bounded rather than single-use: the binding fact is "this
// exact line was shown", which stays true for the same command, and a lost
// record only costs one extra round-trip. Session-scoped through
// opts.sessionId, exactly like the token custody store is state-scoped.
export const ASK_ENVELOPE_TTL_MS = 30 * 60_000;
const shownAskEnvelopes = new Map<string, Map<string, number>>();

function askEnvelopeScope(sessionId: string, tool: string): string {
  return `${sessionId}\u0000${tool}`;
}

/** Record that the T3 envelope for this exact line was shown in this session. */
export function noteAskEnvelopeShown(sessionId: string, tool: string, argsHash: string, at: number = Date.now()): void {
  const scope = askEnvelopeScope(sessionId, tool);
  const live = shownAskEnvelopes.get(scope) ?? new Map<string, number>();
  live.set(argsHash, at);
  shownAskEnvelopes.set(scope, live);
}

/** True when this exact line's envelope was shown in this session and is live. */
export function askEnvelopeLive(sessionId: string, tool: string, argsHash: string, at: number = Date.now()): boolean {
  const scope = askEnvelopeScope(sessionId, tool);
  const live = shownAskEnvelopes.get(scope);
  if (!live) return false;
  // Lazy prune: a session's expired records never accumulate (the map is the
  // only growth surface of this mechanism).
  for (const [hash, shownAt] of live) {
    if (at - shownAt > ASK_ENVELOPE_TTL_MS) live.delete(hash);
  }
  if (live.size === 0) {
    shownAskEnvelopes.delete(scope);
    return false;
  }
  return live.has(argsHash);
}

// ── The S1 retry memo (PR-3a, interrogate round 2: in-memory) ─────────────
//
// A byte-identical repeat after a NON-DELIVERED outcome reuses the prior
// consent. The memo's state is the IN-MEMORY record of what the last
// 'once'-scoped consent's dispatch did — armed by the dispatch recorder
// from the COMPUTED outcome (uncertain/failed arm it, delivered clears it),
// never read back from the ledger. Three properties fall out, each pinned:
// the annotate is best-effort and may fail to write its outcome line, but
// the memo keys on the computed truth, so an unannotated delivered row
// never arms a reuse (round-2 F5); the state dies with the process like
// the T3 binding and the standing map, so a consent whose session ended
// can never arm a cross-process execution (DECISION 3, seat B's F6); and
// only 'once'-scoped arrivals feed it — a standing-consent tick's failed
// dispatch is the grant's own lifecycle, not memo fuel (F4).
const retryMemos = new Map<string, Map<string, boolean>>();

function memoScope(sessionId: string, tool: string): string {
  return `${sessionId}\u0000${tool}`;
}

/** The dispatch recorder's arm/clear seam: one 'once' consent's outcome. */
export function noteRetryMemo(sessionId: string, tool: string, argsHash: string, covering: boolean): void {
  const scope = memoScope(sessionId, tool);
  const live = retryMemos.get(scope) ?? new Map<string, boolean>();
  live.set(argsHash, covering);
  retryMemos.set(scope, live);
}

/** True when the last 'once' consent on this exact key did not deliver. */
export function retryMemoArmed(sessionId: string, tool: string, argsHash: string): boolean {
  const scope = memoScope(sessionId, tool);
  return retryMemos.get(scope)?.get(argsHash) === true;
}

// ── S3 session standing consent (PR-3a) ────────────────────────────────────
//
// The elicitation form's "Remember for this session" tick grants standing
// consent for the exact (session, tool, argsHash) key: identical later
// executions ride the grant with no form, no envelope, and no new consent
// row. The grant PERSISTS for the session — it is never consumed by a ride
// (the first-use disappearance bug the ApprovalCoreConsent spec caught:
// ElicitAllowStanding's later executions must keep riding), and it dies
// only with the process, exactly like the T3 binding map above: a server
// restart forgets it fail-closed, and the retry asks again. The durable
// record is the scope:'session' consent row the tick writes through the
// ledger's tier-safe scoped writer (the row the doctor lists); this map is
// the ride check and the in-memory lifetime.
const standingGrants = new Map<string, Map<string, number>>();

function standingScope(sessionId: string, tool: string): string {
  return `${sessionId}\u0000${tool}`;
}

/** Record the session standing-consent grant the form's tick just created. */
export function noteStandingGrant(sessionId: string, tool: string, argsHash: string, at: number = Date.now()): void {
  const scope = standingScope(sessionId, tool);
  const live = standingGrants.get(scope) ?? new Map<string, number>();
  live.set(argsHash, at);
  standingGrants.set(scope, live);
}

/** True when the session's standing-consent grant covers this exact key. */
export function standingGrantLive(sessionId: string, tool: string, argsHash: string): boolean {
  const scope = standingScope(sessionId, tool);
  const live = standingGrants.get(scope);
  return live !== undefined && live.has(argsHash);
}

// ── The server-run confirmation ladder (PR-1.5) ───────────────────────────
//
// Ask mode no longer trusts a client popup. On a client that declared the
// elicitation form capability in its initialize params, the gate raises the
// form itself (T1): the form body carries the command line and the redacted
// summarize view, and one boolean field is the approval. On a client that
// declared nothing, the gate refuses with a chat round-trip envelope (T3):
// the model must show the command to the user and retry with the attestation,
// which is model-relayed posture trust and every surface labels it so.
// Token mode (T4) is untouched.
export const ELICITATION_DECLINED = 'ELICITATION_DECLINED';
export const ELICITATION_CANCELLED = 'ELICITATION_CANCELLED';
export const ELICITATION_TIMEOUT = 'ELICITATION_TIMEOUT';
export const ELICITATION_FAILED = 'ELICITATION_FAILED';
export const ELICITATION_INVALID_CONTENT = 'ELICITATION_INVALID_CONTENT';
export const ASK_CONFIRMATION_REQUIRED = 'ASK_CONFIRMATION_REQUIRED';

// The explicit abstention bound. The SDK's 60 s default is the no-answer
// bound the probe measured (-32001), and it is shorter than a human reading
// a command line; five minutes leaves room to read and answer without
// leaving an unresponsive client able to stall a call indefinitely.
export const ELICITATION_TIMEOUT_MS = 300_000;

// The enum's VALUES are wire vocabulary and never localize: the gate
// matches them, the ledger and the tests pin them, and a client that
// ignores enumNames (codex renders raw values) still shows the English
// spelling the description teaches. The pre-enum shape was two booleans
// (confirm + rememberForSession), and three measured facts forced the
// merge: codex renders one field per screen, so two booleans were two
// interactions for one decision; the boolean pair admitted a meaningless
// confirm:false + remember:true submission the gate had to silently
// ignore; and opencode's Submit always answers accept, so with a boolean
// the refusal only existed as the unticked default — the #58184 wire
// measurement. The enum makes the refusal an explicit choice, keeps the
// once/session grant one click away, and stays inside the restricted flat
// schema the form mode accepts (string + enum). 'decline' is listed FIRST
// so a client that preselects the first option defaults to the refusal.
const ELICITATION_DECISIONS = ['decline', 'approve-once', 'approve-session'] as const;

// The form is the one surface the HUMAN reads, so its display language
// follows the resolved tier ladder (lib/confirm-language.ts): the
// operator's DEVKIT_CONFIRM_LANG pin, the model's per-call
// confirmLanguage relay of the conversation's language, or the machine
// locale as the floor. A zh resolution renders the form in Simplified
// Chinese; the refusal envelopes and the T3 instruction stay English,
// being model- and log-facing wire vocabulary. enumNames is a
// first-class SDK 1.32.1 keyword (LegacyTitledEnumSchemaSchema carries it,
// probe-verified to round-trip intact) that opencode renders as the
// choice labels (source-verified in toElicitationField); a client that
// ignores the extension falls back to the English enum value.
function elicitSchema(language: ConfirmLanguage): ElicitFormSchema {
  const decision: Record<string, unknown> = {
    type: 'string',
    enum: [...ELICITATION_DECISIONS],
  };
  if (language === 'zh') {
    decision['enumNames'] = ['拒绝', '批准本次', '批准并记住本次会话'];
    decision['title'] = '运行此命令？';
    decision['description'] =
      'approve-once：仅运行这一次。approve-session：同一会话内后续相同调用不再询问（授权持续到 devkit 服务器重启）。decline：拒绝，不执行任何操作。';
  } else {
    decision['title'] = 'Run this command?';
    decision['description'] =
      'approve-once runs it exactly once. approve-session also covers identical later calls in this session (the grant lasts until the devkit server restarts). decline cancels it.';
  }
  return { type: 'object', properties: { decision }, required: ['decision'] };
}

function elicitationRequest(commandLine: string, summary: string, language: ConfirmLanguage): ElicitFormRequest {
  // A tool with an executable line shows it first (the command-forward
  // doctrine); a tool without one (the sandbox lifecycle faces, the auth
  // pair, PR-3c's registrations) centers the redacted summary instead —
  // never a blank command slot under a command heading (interrogate
  // round 2, fix-in-pass ii, adopted by the serial landing). The display
  // strings follow the resolved language (see lib/confirm-language.ts);
  // the brand and the decision vocabulary stay English.
  const zh = language === 'zh';
  const head =
    commandLine !== ''
      ? zh
        ? `HuaweiCloud DevKit 请求你确认运行此命令：\n\n${commandLine}\n\n`
        : `HuaweiCloud DevKit is requesting your confirmation to run this command:\n\n${commandLine}\n\n`
      : zh
        ? 'HuaweiCloud DevKit 请求你确认此操作：\n\n'
        : 'HuaweiCloud DevKit is requesting your confirmation for this request:\n\n';
  const tail = zh
    ? '选择 approve-once 仅运行这一次；选择 approve-session 同时覆盖本会话内后续相同调用（授权持续到 devkit 服务器重启）；拒绝或关闭表单则不执行任何操作。'
    : 'Choose approve-once to run it exactly once, or approve-session to also cover identical later calls in this session (the grant lasts until the devkit server restarts). Decline or dismiss cancels without running anything.';
  return {
    message: head + `${summary}\n\n` + tail,
    schema: elicitSchema(language),
    timeoutMs: ELICITATION_TIMEOUT_MS,
  };
}

function elicitRefusal(outcome: ElicitOutcome, displayLine: string): Record<string, unknown> {
  const nextStep = 'Nothing ran and nothing was approved. Retry the call when the user is ready to answer the form.';
  if (outcome.decision === 'timeout') {
    return {
      status: 'rejected',
      code: ELICITATION_TIMEOUT,
      reason: `the confirmation form was not answered within ${Math.round(ELICITATION_TIMEOUT_MS / 1000)} s.`,
      command: displayLine,
      nextStep,
    };
  }
  if (outcome.decision === 'error') {
    return {
      status: 'rejected',
      code: ELICITATION_FAILED,
      reason: `the client could not deliver the confirmation form (${outcome.detail ?? 'transport failure'}).`,
      command: displayLine,
      nextStep,
    };
  }
  const cancelled = outcome.decision === 'cancel';
  return {
    status: 'rejected',
    code: cancelled ? ELICITATION_CANCELLED : ELICITATION_DECLINED,
    reason: cancelled
      ? 'the user dismissed the confirmation form without approving.'
      : 'the user declined the confirmation form.',
    command: displayLine,
    nextStep: 'Nothing ran. Do not retry the same call without a fresh approval from the user.',
  };
}

// T3: the client cannot render a form, so the model is the relay. The
// envelope names the line it must show — the executable command when the
// tool carries one, else the redacted summary (the commandless faces have
// no command string) — and the exact retry that continues; the refusals
// below and the ledger tier keep the posture labelled where a later
// reader meets it.
function askConfirmationEnvelope(
  commandLine: string,
  summary: string,
  view: { argsHash: string },
): Record<string, unknown> {
  const askLine =
    commandLine !== '' ? 'Show this exact command to the user in chat' : 'Show this exact request to the user in chat';
  return {
    status: 'rejected',
    code: ASK_CONFIRMATION_REQUIRED,
    userConfirmation: {
      needed: true,
      mode: 'chat',
      command: commandLine !== '' ? commandLine : undefined,
      summary,
      instruction:
        `${askLine} and wait for their answer. If they approve, retry the same call ` +
        "with approvedByUser: true. That retry is model-relayed posture trust: it is the user's word as you report it, " +
        'not a mechanically verified answer.',
    },
    argsHash: view.argsHash,
    nextStep: 'Retry with approvedByUser: true only after the user explicitly approves the request above.',
  };
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

  // The approval posture resolves once, before any effect: a bogus
  // DEVKIT_APPROVAL_MODE is boot fail-fast, never a silent fallback.
  const approvalMode = approvalModeFromEnv(process.env);

  const token = typeof args.approvalToken === 'string' ? args.approvalToken : '';

  // The attestation's scope (PR-3b's adopted line, landed here so the
  // registrations' teaching is true at landing): the plan-face tool always
  // demands it (the trunk contract the hcloud battery pins), and EVERY
  // tool demands it once a token rides the call — the token's spend is the
  // confirmed execution, so the agent's statement is part of that
  // contract. Ask mode demands nothing: EVERY arrival there is server-run
  // confirmed — the form on a capable client, the chat envelope on the
  // rest — and the human's answer is the confirmation the attestation only
  // claims, so the bare pass-through that once let a commandless attested
  // arrival execute with no confirmation surface at all is closed (the
  // live incident: run rows with posture evidence, zero forms, zero
  // envelopes). The throw below is therefore token-mode-only.
  const attestationRequired = spec.tokenSource === 'plan-face' || token !== '';
  if (args.approvedByUser !== true && attestationRequired && approvalMode !== 'ask') {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }

  const value = bindingValue(spec, args);

  // The command-forward anchor precedes every mode effect (see the helper):
  // a mismatched or malformed display line rejects with nothing minted,
  // recorded, or executed.
  const commandRefusal = commandAnchorRefusal(spec, value, args.command);
  if (commandRefusal !== null) return { envelope: commandRefusal };

  // Classified flavor engages on content: a classify that says 'none'
  // needs no consent, so no mint, no ledger entry, no gate. The verdict is
  // computed once here and consulted per-branch below, and the floors run
  // BEFORE it (interrogate round 2, finding 5): a credential path in the
  // binding refuses regardless of the flavor outcome — the pass-through
  // skips consent machinery, never safety floors.
  const classifiedPass = spec.flavor === 'classified' && spec.classify?.(value, opts) === 'none';

  if (approvalMode === 'ask') {
    // Floors first, so a refused call is not a consent arrival; a classified
    // pass-through sits after the floors and skips only the consent record.
    assertNoCredentialPath(value, args);
    spec.assertArgsExecutable?.(value, 'ask');
    if (classifiedPass) return { pass: {}, binding: value };

    const view = spec.summarize(value);
    // The display line every confirmation surface shows: the REDACTED
    // view.command — the same redaction the pin view carries — never the
    // raw args.command the anchor validated (interrogate F1: the form head
    // and the T3 envelope echoed a plaintext secret from the raw field).
    // The legacy args-only shape keeps its redacted echo; the no-command
    // faces show the summary alone (never a blank command slot,
    // interrogate round 2 fix-in-pass ii).
    const commandLine = view.command ?? '';
    const sessionId = opts.sessionId ?? 'default';
    const consented = (evidence: 'elicitation' | 'posture'): ApprovalGateOutcome => {
      const arrival = recordAskModeConsent({
        sessionId,
        tool: name,
        argsHash: view.argsHash,
        outcome: 'granted',
        evidence,
        evidenceFinal: true,
        command: view.command,
      });
      // The arrival's IDENTITY (round 15, finding 2): the stamp AND the seq —
      // the dispatch layer threads both to the delivery recorder so the
      // annotate binds the outcome line to EXACTLY the row this arrival
      // wrote, never to a positional candidate (a same-ms twin compacted in
      // behind used to steal the line). The binding rides along: the value
      // resolved BEFORE the confirmation surface was shown, so a credential-
      // consuming handler executes the approved snapshot, never a
      // post-consent re-read (PR-3b's TOCTOU finding — the shown account is
      // the executed account).
      return {
        pass: { arrivalStamp: arrival.grantedAt, arrivalSeq: arrival.arrivalSeq, consentScope: 'once' },
        binding: value,
      };
    };

    // S3 standing consent: a grant the user ticked covers identical later
    // executions for the session. The ride writes NO new consent row (the
    // grant row is the durable record; the TLA+ StandingRun models the ride,
    // not a new consent) and never consumes the grant — the first-use
    // disappearance bug the spec caught.
    if (standingGrantLive(sessionId, name, view.argsHash)) {
      return { pass: { approvedVia: 'standing-session' }, binding: value };
    }

    // The S1 retry memo: a byte-identical repeat after a non-delivered
    // outcome reuses the prior consent — no second form, no fresh envelope
    // (the carve the T3 binding's arrival condition needed: an attested
    // retry whose shown-envelope record expired rides the memo instead of
    // silently degrading to a fresh chat round-trip). The reuse row
    // inherits the original's evidence tier through the ledger's
    // never-upgrade resolution (the caller's tier is only the no-original
    // fallback, so the posture floor holds), the arrival identity rides
    // the pass so this dispatch's own outcome re-arms or clears the memo
    // for the next identical call, and the consent scope stays 'once'.
    if (retryMemoArmed(sessionId, name, view.argsHash)) {
      const arrival = recordAskModeConsent({
        sessionId,
        tool: name,
        argsHash: view.argsHash,
        outcome: 'granted',
        evidence: 'posture',
        command: view.command,
      });
      return {
        pass: {
          approvedVia: 'retry-uncertain',
          arrivalStamp: arrival.grantedAt,
          arrivalSeq: arrival.arrivalSeq,
          consentScope: 'once',
        },
        binding: value,
      };
    }

    // T1: the client declared elicitation.form, so the gate raises the form
    // itself. The accept IS the confirmation (the attestation is not
    // consulted: a human answered, which is strictly stronger). Any other
    // answer — decline, dismiss, the explicit timeout, a transport failure,
    // an accept that chose decline, or an accept whose content carries no
    // valid decision value — refuses fail-closed: nothing executes, nothing
    // mints, nothing is recorded.
    // The form's display language resolves per arrival (the operator pin,
    // the model's confirmLanguage relay, the machine locale — in that
    // order; lib/confirm-language.ts owns the ladder).
    const language: ConfirmLanguage = resolveConfirmLanguage(args, process.env);
    const elicitation = opts.elicitation;
    if (elicitation?.capable) {
      const outcome = await elicitation.prompt(elicitationRequest(commandLine, view.summary, language));
      // The enum's three values map the ladder: decline is the explicit
      // refusal; approve-once is a fresh single consent; approve-session
      // additionally arms the S3 standing grant. An accept with a MISSING or
      // unknown decision value gets its own refusal code: hermes answers the
      // form path with accept and empty content (measured in its source —
      // its panel never synthesizes answers from the schema it was shown),
      // and that shape must be diagnosable from the refusal alone instead
      // of reading as a generic transport failure.
      const decision = outcome.decision === 'accept' ? outcome.content?.['decision'] : undefined;
      if (
        decision === undefined ||
        typeof decision !== 'string' ||
        !(ELICITATION_DECISIONS as readonly string[]).includes(decision)
      ) {
        if (outcome.decision !== 'accept') return { envelope: elicitRefusal(outcome, commandLine) };
        return {
          envelope: {
            status: 'rejected',
            code: ELICITATION_INVALID_CONTENT,
            reason:
              'the client answered accept but the submitted form content carries no valid decision value — the client did not answer the form schema it was shown.',
            command: commandLine,
            nextStep:
              'Nothing ran and nothing was approved. The client must submit one of: decline, approve-once, approve-session.',
          },
        };
      }
      if (decision === 'decline') {
        // The explicit refusal choice maps to the same fail-closed envelope
        // as the wire-level decline (the pre-enum shape reached this branch
        // through the confirm:false rewrite; the enum makes it a first-class
        // answer).
        return {
          envelope: {
            status: 'rejected',
            code: ELICITATION_DECLINED,
            reason: 'the user declined the confirmation form.',
            command: commandLine,
            nextStep: 'Nothing ran. Do not retry the same call without a fresh approval from the user.',
          },
        };
      }
      // The standing-consent choice: this execution is a fresh consent (the
      // row carries the elicitation evidence and the session scope — the
      // durable grant record the doctor lists), and the in-memory grant
      // covers identical later executions until the process dies. The
      // scope-'session' pass is the recorder's memo-exclusion signal: the
      // grant's own delivery outcome is the grant's lifecycle, never memo
      // fuel (round-2 F4).
      if (decision === 'approve-session') {
        noteStandingGrant(sessionId, name, view.argsHash);
        const arrival = recordAskModeConsent({
          sessionId,
          tool: name,
          argsHash: view.argsHash,
          outcome: 'granted',
          evidence: 'elicitation',
          evidenceFinal: true,
          command: view.command,
          scope: 'session',
        });
        return {
          pass: { arrivalStamp: arrival.grantedAt, arrivalSeq: arrival.arrivalSeq, consentScope: 'session' },
          binding: value,
        };
      }
      return consented('elicitation');
    }

    // T3: no form capability. The attested path executes only when THIS
    // line's envelope was shown in this session (see the binding state
    // above): the args hash the envelope advertised is the binding, so a
    // retry for different args — and a pre-attested first call — gets the
    // envelope for the line they ask about instead of executing. The refusal
    // teaches the ritual for the new line, so the proper envelope-then-retry
    // still completes. The binding covers EVERY ask arrival — the
    // commandless bare-attestation pass-through (once this block's skipped
    // shape, executing with no confirmation surface at all) is the hole
    // this doctrine closed.
    const envelopeShown = askEnvelopeLive(sessionId, name, view.argsHash);
    if (args.approvedByUser !== true || !envelopeShown) {
      noteAskEnvelopeShown(sessionId, name, view.argsHash);
      return { envelope: askConfirmationEnvelope(commandLine, view.summary, view) };
    }
    return consented('posture');
  }

  if (!token) {
    // plan-face keeps the trunk contract: the plan face is the only
    // minter, so a no-token run call is a not-found rejection and the
    // gate mints nothing. The floors do not preempt this envelope — trunk
    // classified nothing on a tokenless call, and the plan face's own hook
    // deny already covers the credential class at plan time.
    if (spec.tokenSource === 'plan-face') {
      return {
        envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND', nextStep: PLAN_FACE_TOKEN_MISSING_NEXT_STEP },
      };
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
    if (classifiedPass) return { pass: {}, binding: value };
    const view = spec.summarize(value);
    const minted = createApprovalToken(value, { secretsSubstitutable: false, argsPinView: view.pinView });
    return {
      envelope: {
        status: 'rejected',
        code: 'USER_CONFIRMATION_REQUIRED',
        approvalToken: minted,
        userConfirmation: {
          needed: true,
          // Order matters: the summarize view carries its own `command`
          // (the redacted executable line, PR-1.5), and spreading it after
          // this line overwrote the approve command the user must run.
          ...view,
          command: `npx huaweicloud-devkit approve ${minted}`,
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
    return {
      envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED', nextStep: CONFIRM_TOKEN_EXPIRED_NEXT_STEP },
    };
  }
  if (inspection.state === 'not_found') {
    // A token that was never created (typo / unknown / pruned beyond the
    // tombstone window) is still a rejection, but carries no expired or
    // already semantics — a distinct code so clients can tell them apart.
    return {
      envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND', nextStep: CONFIRM_TOKEN_UNKNOWN_NEXT_STEP },
    };
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
    if (recheck.state === 'expired') {
      return {
        envelope: { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED', nextStep: CONFIRM_TOKEN_EXPIRED_NEXT_STEP },
      };
    }
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
        'Provided args do not match the approved confirmation. Use the exact args the confirmation shows. ' +
          'If it shows <redacted> for passwords or secrets, replace <redacted> with the actual values.',
      );
    }
    // Views equal means ONLY secret values differ. The confirmed call carried real
    // (non-placeholder) secrets → they are pinned: a different real secret
    // rejects. A placeholder-bearing confirmation (secretsSubstitutable) keeps
    // the documented substitution flow.
    if (stored.secretsSubstitutable !== true) {
      throw new Error(
        'Secret values are pinned to the approved confirmation: get a fresh confirmation for the final values and retry with it.',
      );
    }
  }

  // The token spent and the binding verified: the registered handler runs
  // the pure execution it owns. The binding rides along: this call's
  // recomputed resolution, which the hash comparison just proved equal to
  // the minted one, so the handler executes exactly what was approved —
  // never a post-consent re-read (PR-3b's TOCTOU finding).
  return { pass: {}, binding: value };
}

// The dispatch-result follow-up (round 10, finding 4, PR-3a's memo
// datum): after the pack handler the gate's caller dispatched returns —
// or throws — callTool hands the result here, and this records what
// became of the call the gate approved, on the gate's behalf. The gate
// itself returns a structured pass before dispatch (its ask branch carries
// the arrival's stamp — the recorded PR-3a approvedVia precursor); the
// dispatch layer is the only place that ever sees the handler's return or
// throw, so it is the only place the delivery class can be observed.
//
// The classes, from the handler's return or throw: 'delivered' when the
// returned result carries no failure marks, 'failed' when the child
// ANSWERED with a failure, 'uncertain' when the handler threw and whether
// the call completed is unknowable. PR-3a's S1 memo reuses a prior
// consent exactly on 'uncertain' or 'failed' (ApprovalCoreConsent's
// result-conditioned scope).
//
// Ownership by stamp (round 12, finding 2, both seats' shape): the
// arrival stamp the gate returned MUST reach the annotate — no stamp
// (a recorder call without one, token mode where no arrival was
// recorded, any failure) means no annotate, ever, because absence never
// proves which row this dispatch created. The annotate then requires a
// row with EXACTLY that stamp in the main store, so a dropped or degraded
// arrival's outcome lands nowhere at all.
//
// Best-effort in every direction: ask mode only (token mode records no
// arrival, so there is no row to annotate — and the check keeps the
// default-mode dispatch path free of any ledger work), no-ops without a
// spec, and never throws — a recording failure must never fail the call
// it is recording.
export function recordApprovalDispatchOutcome(
  name: ToolName,
  spec: ApprovalSpec | undefined,
  args: ToolArgs,
  opts: CallToolOptions,
  handlerResult: unknown,
  handlerThrew?: unknown,
  arrivalStamp?: number,
  arrivalSeq?: number,
  consentScope?: ApprovalConsentScope,
): void {
  try {
    if (!spec) return;
    if (approvalModeFromEnv(process.env) !== 'ask') return; // no ask arrival was recorded
    const outcomeDetail: ConsentDeliveryOutcome =
      handlerThrew !== undefined ? 'uncertain' : handlerResultCarriesFailure(handlerResult) ? 'failed' : 'delivered';
    // The retry memo's state (interrogate round 2): armed from the COMPUTED
    // outcome, before the best-effort annotate and independent of its
    // success — a failed annotate may leave the ledger row without its
    // outcome line, but the memo never reads the ledger back, so an
    // unannotated delivered row can never arm a reuse (F5). Only
    // 'once'-scoped arrivals feed it; a standing tick's outcome is the
    // grant's own lifecycle, not memo fuel (F4).
    if (consentScope === 'once' && typeof arrivalStamp === 'number') {
      noteRetryMemo(
        opts.sessionId ?? 'default',
        name,
        hashArgs(bindingValue(spec, args)),
        outcomeDetail !== 'delivered',
      );
    }
    annotateDispatchOutcome({
      sessionId: opts.sessionId ?? 'default',
      tool: name,
      argsHash: hashArgs(bindingValue(spec, args)),
      arrivalStamp,
      arrivalSeq,
      outcomeDetail,
    });
  } catch {
    // best-effort by contract: the dispatch outcome is a convenience
    // datum; the consent (the safety-critical fact) is already recorded
  }
}

// The failure-mark reader for the three-valued delivery classification
// (rounds 11-12): a returned result is 'failed' when the child ANSWERED
// with a failure — by any of the shapes the handler families report it
// in. Round 12, finding 1 (both seats, complementary shapes) fixed the
// reading ORDER: an EXPLICIT success signal wins before every failure
// mark. The run engine's own ok gate returns ok:true with a NONZERO
// exitCode for OBS success (obsutil exits nonzero on success text —
// repo-pinned #921), so an unconditional exitCode mark recorded a
// delivered OBS write as failed; the PR-3c handler successes carry
// benign human-facing message fields, so an unconditional message mark
// recorded every successful signed PUT and upgrade as failed. The
// permissive direction makes it worse than cosmetic: PR-3a's memo
// reuses prior consent exactly on failed/uncertain, so a delivered call
// recorded failed grants the next identical call a popup-free reuse.
//
// The order: (1) explicit success — ok === true, success === true, or
// status === 'ok' — short-circuits to delivered, whatever failure-shaped
// fields ride along; (2) an ok field that is not success is the explicit
// verdict (false or the loose string 'false' → failed); (3) exitCode
// marks ONLY when the shape carries no ok field at all (the sandbox exec
// faces' {stdout, exitCode} — the r11 shapes exitCode:1 stays failed,
// exitCode:0 delivered); (4) a rejected/error status; (5) an
// error-truthy error/errorMessage/message value. A RETURNED Error
// instance is judged failed, recorded honestly: a returned error is an
// ANSWER (the handler decided the call failed), not an uncertainty —
// the thrown leg above stays the only 'uncertain'. Every other returned
// shape — no success signal, no failure marks — is 'delivered' (the
// void handler, the async-start receipt {started:'uncertain'}: an
// accepted start is a delivered dispatch, and the async completion is
// the poll call's own result).
// The benign-message content test (round 14, finding 3; rounds 15-16,
// findings 3/4 — both seats both rounds): the failure vocabulary the real
// handlers' message channels use, both languages — small and honest, not
// a heuristic. Round 15 added a 16-char negation proximity window; round
// 16 falsified it in BOTH directions: a REAL failure behind a verb-
// negation read delivered (无法确认，查询失败 / 无法完成提交，操作失败 —
// 无法 and 未通过 negate the VERB, not the failure noun that follows, so
// six genuine error reports recorded delivered), and genuinely benign
// absence phrasings read failed (error-free / 0 errors / cannot be any
// error / 错误未发生). Proximity cannot decide polarity in either
// language, so the window is GONE: the test now runs on an explicit
// absence vocabulary. A message whose failure markers are all covered by
// an explicit absence phrase (the marker negated by construction: "no
// error", "0 errors", "error-free", 未发生错误, 无 error, nothing to do,
// 已是最新, 无需升级) is benign by CONTENT — the absence phrases are
// stripped before the scan, so a failure marker OUTSIDE them always
// wins, whatever negation characters surround it: 查询失败 and "failed to
// write config" record failed regardless of the 无 in 无法 or a leading
// "no error in cleanup" clause, and the real failure envelope
// 无法确认最新版本（registry 查询失败） keeps its hit. The ZH markers get
// NO character-level negation logic at all (round 16's explicit call):
// 无/未/没有 are not negation morphemes for the failure nouns, only the
// enumerated phrases are.
const MESSAGE_FAILURE_MARKERS = [
  'failed',
  'error',
  'exception',
  'denied',
  'rejected',
  'is not',
  '失败',
  '错误',
  '未通过',
];

// The explicit absence/no-op vocabulary, both languages. Every phrase that
// NEGATES a failure marker must cover the marker word itself (the phrase
// is stripped from the message before the marker scan), so "no error"
// strips the "error" it contains and "nothing was denied" strips the
// "denied". A phrase that merely asserts success without covering a
// marker (完成 alone — it sits inside 无法完成) stays OUT: the carve-out
// keys on the marker's absence, not on a success word's presence.
const BENIGN_ABSENCE_PHRASES = [
  // EN: the marker word explicitly negated, excluded, or counted at zero.
  'no error',
  'no errors',
  'no failure',
  'no failures',
  'no exception',
  'no exceptions',
  'no denial',
  'not denied',
  'nothing was denied',
  '0 errors',
  'zero errors',
  'zero failures',
  'error-free',
  'failure-free',
  'exception-free',
  'without error',
  'without errors',
  'without failures',
  'without any error',
  'not any error',
  'cannot be any error',
  'error was not detected',
  'errors were not detected',
  'error did not occur',
  'errors did not occur',
  // EN: the no-op/OK assertion vocabulary (the marker-free companions).
  'nothing to do',
  'no change',
  'nothing failed',
  'did not fail',
  'unchanged',
  // ZH: the error word explicitly negated (the enumerated forms; 无/未/没有
  // by themselves are NOT negations of 错误/失败).
  '未发生错误',
  '错误未发生',
  '没有发生错误',
  '未出现错误',
  '错误未出现',
  '无错误',
  '没有错误',
  '无任何错误',
  '无 error',
  '没有 error',
  // ZH: the no-op/OK assertion vocabulary (the real up-to-date envelope).
  '已是最新',
  '无需升级',
  '无需操作',
  '无需',
];

function messageCarriesFailure(message: string): boolean {
  let rest = message.toLowerCase();
  // Strip every explicit absence phrase FIRST: a marker covered by an
  // absence phrase is benign by content; a marker outside them is a real
  // failure report and survives the strip with its polarity untouched.
  for (const phrase of BENIGN_ABSENCE_PHRASES) {
    if (!rest.includes(phrase)) continue;
    rest = rest.split(phrase).join('\u0000');
  }
  return MESSAGE_FAILURE_MARKERS.some((marker) => rest.includes(marker));
}

function handlerResultCarriesFailure(handlerResult: unknown): boolean {
  if (handlerResult instanceof Error) return true; // returned, not thrown: an answer
  if (typeof handlerResult !== 'object' || handlerResult === null) return false;
  const record = handlerResult as Record<string, unknown>;
  // (1) An explicit success signal wins before every failure mark.
  if (record.ok === true || record.success === true || record.status === 'ok') return false;
  // (2) The upgrade family's benign no-op envelope (round 13, finding 3):
  // `success: false` plus the requiresRestart marker plus a BENIGN message,
  // with no error field — the REAL "already at the latest version" return
  // of upgradePackage/handleUpgrade ({success:false, message:'已是最新版本…',
  // requiresRestart:false}). Round 14, finding 3 (both seats): the message's
  // CONTENT must be benign — an error-ish message under the marker pair is
  // a real failure reported in the message channel ({success:false,
  // requiresRestart:true, message:'failed: network error'} recorded
  // delivered pre-fix — a suppressed failure, the permissive direction the
  // memo keys on), so the carve-out requires a message free of the failure
  // vocabulary below and an error-ish shape falls through to the failure
  // marks. A bare {success:false} (no marker pair) reads failed: the real
  // up-to-date envelope carries all three.
  if (
    record.success === false &&
    record.requiresRestart !== undefined &&
    typeof record.message === 'string' &&
    record.message.length > 0 &&
    !messageCarriesFailure(record.message) &&
    record.error === undefined &&
    record.errorMessage === undefined
  ) {
    return false; // an explicit benign "nothing to do" answer: delivered
  }
  if (record.success === false) return true; // not-ok with no benign carve-out: failed
  // (3) An ok field that is not success is the explicit verdict.
  if (record.ok === false || record.ok === 'false') return true;
  // (4) exitCode marks only shapes with no ok field (the exec faces).
  if (!('ok' in record) && typeof record.exitCode === 'number' && record.exitCode !== 0) return true;
  if (record.status === 'rejected' || record.status === 'error') return true;
  const failure = record.error ?? record.errorMessage ?? record.message;
  return failure !== undefined && failure !== null && failure !== '';
}
