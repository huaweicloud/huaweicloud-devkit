// The generalized approval gate's vocabulary: the spec a tool's owner
// registers, and the consent event the ledger records. Zod-free by design
// — the bundled mcp-server graph, the hook graph (the .mjs twin imports
// only the roster leaf), and PR-2's unbundled opencode-writer graph all
// consume this shape. The only import is type-only (erased at runtime, the
// pack-types.ts precedent), so the roster leaf (approval-roster.ts) stays
// import-free for the hook's src fallback and this module adds no runtime
// edge to any graph.
//
// PR-1 registers one tool (huaweicloud_run_approved_command, tokenSource
// 'plan-face'); the pack registrations land in PR-3. The shape below is
// the whole program's contract surface, landed once so later PRs only add
// data.
import type { ToolArgs, CallToolOptions } from './tools.ts';

// Which flavor of gate a registered tool carries. 'always' engages the
// approval gate on every call; 'classified' first consults the pure
// classify function and engages only when it says the content requires a
// human (ApprovalCoreMint's classify-before-mint: destructive content is a
// disabled guard at the gate face, never a minted token the run then
// denies — NoDoomedToken).
export type GateFlavor = 'always' | 'classified';

// Where the token that spends an approval comes from. 'plan-face' keeps
// the trunk contract for the hcloud pair: the plan face
// (planHcloudCommand) is the ONLY minter, so a no-token run call returns
// CONFIRM_TOKEN_NOT_FOUND and the gate mints nothing. 'gate' is every
// PR-3 registration: the gate itself mints on the first no-token call and
// returns the USER_CONFIRMATION_REQUIRED envelope with the fresh
// approvalToken, executing nothing.
export type ApprovalTokenSource = 'plan-face' | 'gate';

// The consent channel a ledger entry records. 'terminal' is the approve CLI
// (PIN-checked, the human's own TTY); 'elicitation' is a client-relayed
// allow (PR-4 — client-relay evidence, never human-present by itself);
// 'posture' is ask mode, where the harness client's permission prompt on
// the very call is the confirmation.
export type ConsentEvidence = 'terminal' | 'elicitation' | 'posture';

// The result a classified tool's pure classify function reports:
// 'required' engages the approval gate (and, at consume time on a
// plan-face tool, is exactly the grant requirement the trunk strict plan
// computed — a read-classified command executes on an unconfirmed token);
// 'none' lets the call pass through ungated.
export type ClassifyVerdict = 'required' | 'none';

// What a registered tool declares to the dispatch-layer gate. Every spec
// function operates on the BINDING VALUE — normalizeArgs(args) when the
// tool provides one, the raw args otherwise — so the gate hashes, guards,
// and summarizes exactly the value the token binds, never a wrapper-noise
// variant of it.
export interface ApprovalSpec {
  // The capability domain the gate protects ('cli', 'sandbox', 'auth',
  // 'obs', 'secrets', 'packs'). A seam for later per-domain reporting;
  // per Appendix B there is deliberately no second mode knob.
  domain: string;
  flavor: GateFlavor;
  tokenSource: ApprovalTokenSource;
  // Content classification over the binding value. For a classified
  // flavor it gates engagement (before any mint). For the plan-face hcloud
  // tool it answers the consume's requireGrant, replacing the strict
  // plan's userConfirmation.needed with the same pure verdict.
  classify?: (bindingValue: unknown, opts: CallToolOptions) => ClassifyVerdict;
  // Effective-args binding: the value whose hash the token binds and the
  // ledger records. The hcloud pair strips a leading bin token, so a run
  // call that echoes the plan verbatim and one that sends the cleaned
  // args bind identically (2026-11-05 UX report #6).
  normalizeArgs?: (args: ToolArgs) => unknown;
  // Execution-readiness floor the gate enforces BEFORE the token is
  // consumed (the hcloud placeholder-secret guard): throwing rejects the
  // call without burning the token, so the guidance stays followable on
  // the same approval. Mode-aware because the re-run wording differs —
  // token mode keeps the guidance on the same approval, ask mode has no
  // token to reference.
  assertArgsExecutable?: (bindingValue: unknown, mode: 'token' | 'ask') => void;
  // True when the tool's own handler refuses calls that lack the stdio
  // session seam (packs_configure: the refusal lives inside the handler,
  // downstream of any dispatch-layer gate). The gate checks
  // opts.onPacksChanged presence BEFORE engaging, mirroring the handler's
  // own refusal, so a no-seam call returns the stdio-only refusal with no
  // token minted and no ledger entry (ApprovalCoreMint GateMintSeam's
  // disabled-guard posture).
  requiresSessionSeam?: boolean;
  // The redacted popup view plus the pin-view binding: one or two short
  // lines naming the tool and the pinned arguments (never the raw argument
  // stream — a popup must not leak secrets), the binding-value hash, and
  // the pin view the mismatch path compares against the stored entry.
  summarize: (bindingValue: unknown) => { summary: string; argsHash: string; pinView: unknown };
}

// The consent event the ledger stores (approval-ledger.ts). Ask-mode
// arrivals write one; token mode keeps its existing semantics (single use,
// tombstone, five-minute TTL) and records nothing — its evidence is the
// custody-HMAC grant inside approvals.json. The event's subject is the
// CONSENT's lifecycle, not the handler's internals: it records that the
// user allowed this exact call (the arrival ApprovalCoreConsent models as
// the human yes) and — as a best-effort follow-up the dispatch layer
// writes after the handler returns (round 10, finding 4) — what became of
// the call the consent authorized, in outcomeDetail. `outcome` is the
// consent's own outcome — 'granted' when the call was allowed, 'denied'
// when the popup was declined; `outcomeDetail` is the dispatch result of
// the approved call ('delivered' | 'uncertain' | 'failed'), the datum
// PR-3a's retry memo keys reuse on. Neither field claims anything about
// the handler's internal execution beyond that delivery class.
export interface ConsentEvent {
  sessionId: string;
  tool: string;
  argsHash: string;
  outcome: 'granted' | 'denied';
  grantedAt: number;
  scope: 'once' | 'session';
  evidence: ConsentEvidence;
  // The arrival counter (rounds 13-15): a monotonically increasing
  // per-store sequence the ledger assigns on EVERY append — the true
  // chronology key for the tier resolution, immune to clock steps. A
  // backward NTP/VM-restore step gives a later-written copy a SMALLER
  // grantedAt, and grantedAt-only chronology then names the failure-born
  // copy the original — the fabricated upgrade the never-upgrade rule
  // exists to prevent, with no tiebreak firing (the stamps differ). The
  // resolution orders by (arrivalSeq, grantedAt): the counter tracks real
  // arrival order (a tiny high-water file beside the store, floored by the
  // parsed store on every locked append), so a later-arriving row never
  // sorts as the original whatever the wall clock did. grantedAt stays
  // for display and the annotate's stamp-keyed join.
  //
  // The assignable space is integers in [0, MAX_SAFE_INTEGER - 2]; the
  // sentinel (MAX_SAFE_INTEGER) and the value below it are never assigned
  // and never valid (round 15, finding 1: a corrupted row or file near
  // 2^53 used to walk the counter onto the sentinel and past the safe
  // range, permanently duplicating locked writers' seqs and re-opening the
  // r13 upgrade). A row whose seq is absent, null, fractional, negative,
  // Infinite, or otherwise outside the space reads as the SENTINEL: the
  // row stays VISIBLE, sorts newest, and can never be an original — never
  // invisible (the pre-r15 fix lost an Infinity-serialized row entirely
  // when it round-tripped as arrivalSeq:null). Ledger-written rows always
  // carry a valid seq; the normalization covers corruption and pre-field
  // rows.
  arrivalSeq: number;
  // The dispatch outcome of the call this consent authorized (round 10,
  // finding 4 — PR-3a's memo datum). Absent on every row written before
  // the dispatch layer's follow-up lands, and on any follow-up that could
  // not be recorded best-effort.
  outcomeDetail?: ConsentDeliveryOutcome;
}

// What became of the call a consent authorized, as observed by the
// dispatch layer that ran the handler: 'delivered' when the handler
// returned an ok result, 'failed' when it returned a not-ok result (the
// non-delivered class — the child answered with a failure), 'uncertain'
// when the handler threw and whether the call completed is unknowable.
// PR-3a's S1 memo reuses a prior consent exactly when this is 'uncertain'
// or 'failed' (ApprovalCoreConsent's result-conditioned scope).
export type ConsentDeliveryOutcome = 'delivered' | 'uncertain' | 'failed';
