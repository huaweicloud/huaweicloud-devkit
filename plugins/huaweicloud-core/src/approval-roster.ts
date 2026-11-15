// The approval-gate roster: which tools the dispatch-layer approval gate
// covers. A const string tuple, zod-free, import-free — the .mjs hook twin
// and the opencode ask-rule writer both import this shape from the compiled
// tree, and neither may pull the SDK/zod graph (the hook runs before dist
// exists in a raw checkout; the writer lives in the unbundled setup-cli
// graph). The gate (approval-gate.ts) resolves specs from packs/registry.ts's
// APPROVAL_SPECS merge, whose satisfies check is keyed by THIS tuple's
// literal union — that coupling is the reason for `as const`: a
// ReadonlyArray<string> widens the key type to string and silently inerts
// the compile-time closure (an interrogate-round-1 finding).
//
// PR-1 populates the roster with the hcloud pair's run face only; the pack
// registrations land in PR-3. Two lists, not one, because the two flavors
// need different downstream facts: always tools get client ask-rules and
// _meta flags, classified tools additionally need a classify in their spec
// (pinned by structure.test.ts: every APPROVAL_CLASSIFIED_TOOLS entry must
// provide one).

export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;

export const APPROVAL_CLASSIFIED_TOOLS: readonly never[] = [];

// Each roster member's MCP payload shape class (round 10, finding 3): the
// hook exemption admits a roster-attributed payload only when it matches
// ITS tool's row here. The run face carries its argv as an `args` array;
// PR-3a's sandbox exec faces (exec_with_session, exec_one_shot) carry a
// `command` string — a payload shape the round-1/round-2 exemption had
// to reject on the run face's name (a command string there is the
// Bash-shaped smuggle the shape test exists to block), so without this
// table PR-3a's registrations could never reach the server gate on
// hook-bearing harnesses. The Record is keyed by the roster tuple, so a
// registration that widens APPROVAL_TOOLS fails the build until its
// shape row lands with it. Rows go live with their registrations — until
// PR-3a lands, only the run face is listed; the hook's fallback for a
// roster member with no row (an older roster leaf, or the transition
// window during PR-3's own landing) is documented in the hook itself.
// The Record is keyed by the roster tuple inline (this module is
// import-free — it cannot take ApprovalRosterName from the registry, so
// the tuple is widened here the same way the registry widens it).
export type ApprovalToolInputShape = 'argsArray' | 'commandString';

export const APPROVAL_TOOL_INPUT_SHAPES: Record<(typeof APPROVAL_TOOLS)[number], ApprovalToolInputShape> = {
  huaweicloud_run_approved_command: 'argsArray',
};
