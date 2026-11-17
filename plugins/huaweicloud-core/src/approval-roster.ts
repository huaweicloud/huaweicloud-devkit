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
// PR-1 populated the roster with the hcloud pair's run face; PR-3a added
// the sandbox pack's eight mutating faces (connect, the two exec tools,
// the three tunnel faces, sign_agreement, credentials); the port-pr6 wave
// added shutdown — the irreversible core-hour stop (an unrostered shutdown
// is a safety hole: the tool exists but nothing gates it); PR-3b adds the auth
// account-switch pair — the account switch can redirect every downstream
// approved write to a different account, so it earns a human present on
// every call; PR-3c adds the obs pair as the first classified members
// (action=get is a signed read and must never confirm) and the three
// always tools (upgrade replaces its description-level consent with the
// mechanical gate; secret_delete is destructive with no version history;
// packs_configure widens the disclosure face). secret_set stays OFF the
// roster — the user is the plaintext source and is therefore present —
// and setup_obs_config stays off as the flagged boundary item. Two
// lists, not one, because the two flavors need different downstream
// facts: always tools get client allow rules on install (the yield
// posture), classified tools additionally need a classify in their spec
// (pinned by structure.test.ts: every APPROVAL_CLASSIFIED_TOOLS entry
// must provide one).

export const APPROVAL_TOOLS = [
  'huaweicloud_run_approved_command',
  'huaweicloud_sandbox_connect',
  'huaweicloud_sandbox_exec_with_session',
  'huaweicloud_sandbox_exec_one_shot',
  'huaweicloud_sandbox_expose_tunnel',
  'huaweicloud_sandbox_renew_tunnel',
  'huaweicloud_sandbox_keepalive_watchdog',
  'huaweicloud_sandbox_sign_agreement',
  'huaweicloud_sandbox_credentials',
  'huaweicloud_sandbox_shutdown',
  'huaweicloud_auth_init',
  'huaweicloud_auth_switch',
  'huaweicloud_obs_set_website_config',
  'huaweicloud_obs_set_cors',
  'huaweicloud_upgrade',
  'huaweicloud_secret_delete',
  'huaweicloud_packs_configure',
] as const;

// The classified members: PR-3a's exec pair and PR-3c's obs pair. A const
// tuple by the same round-1..5 widening doctrine as APPROVAL_TOOLS (the
// compile-time classified-provides-classify consumers key on the runtime
// list, and a widened element would inert them) — structure.test.ts pins
// the shape.
export const APPROVAL_CLASSIFIED_TOOLS = [
  'huaweicloud_sandbox_exec_with_session',
  'huaweicloud_sandbox_exec_one_shot',
  'huaweicloud_obs_set_website_config',
  'huaweicloud_obs_set_cors',
] as const;

// Each roster member's MCP payload shape class (round 10, finding 3): the
// hook exemption admits a roster-attributed payload only when it matches
// ITS tool's row here. The run face carries its argv as an `args` array;
// the sandbox exec faces carry a `command` string — a payload shape the
// round-1/round-2 exemption had to reject on the run face's name (a command
// string there is the Bash-shaped smuggle the shape test exists to block),
// so without this table the sandbox registrations could never reach the
// server gate on hook-bearing harnesses. The Record is keyed by the roster
// tuple, so a registration that widens APPROVAL_TOOLS fails the build until
// its shape row lands with it. The hook's shape switch knows 'argsArray',
// 'commandString', and 'structured': the first two are the exempt classes
// (with different skip sets); 'structured' declares a no-command-surface
// payload — the hook branch returns no exemption for it, and full
// classification stands (fail-closed: their payload shapes classify clean,
// and any deny the classifier ever adds still blocks the call at the hook
// layer, while a stuffed command/argv on those names can never borrow the
// exempt classes). The auth pair (PR-3b) rides 'structured' too: its named
// credential fields are a no-command-surface payload, and the server gate
// does not classify that payload text. The fallback below exists ONLY for
// a MISSING row (an older roster leaf or the landing transition), never
// for a present row the hook does not know.
// The Record is keyed by the roster tuple inline (this module is
// import-free — it cannot take ApprovalRosterName from the registry, so
// the tuple is widened here the same way the registry widens it).
// PR-3c's registrations (obs config, upgrade, secret_delete,
// packs_configure) ride 'structured' like PR-3a's lifecycle faces and
// PR-3b's auth pair: plain argument payloads, no command surface, no
// exemption (measured: every real payload classifies allow, so the calls
// reach the server gate with full hook classification standing). The
// port-pr6 shutdown row rides 'structured' the same way — plain id
// fields (session_id/dev_stage_id/workspace_id), no command surface.
export type ApprovalToolInputShape = 'argsArray' | 'commandString' | 'structured';

export const APPROVAL_TOOL_INPUT_SHAPES: Record<(typeof APPROVAL_TOOLS)[number], ApprovalToolInputShape> = {
  huaweicloud_run_approved_command: 'argsArray',
  huaweicloud_sandbox_connect: 'structured',
  huaweicloud_sandbox_exec_with_session: 'commandString',
  huaweicloud_sandbox_exec_one_shot: 'commandString',
  huaweicloud_sandbox_expose_tunnel: 'structured',
  huaweicloud_sandbox_renew_tunnel: 'structured',
  huaweicloud_sandbox_keepalive_watchdog: 'structured',
  huaweicloud_sandbox_sign_agreement: 'structured',
  huaweicloud_sandbox_credentials: 'structured',
  huaweicloud_sandbox_shutdown: 'structured',
  huaweicloud_auth_init: 'structured',
  huaweicloud_auth_switch: 'structured',
  huaweicloud_obs_set_website_config: 'structured',
  huaweicloud_obs_set_cors: 'structured',
  huaweicloud_upgrade: 'structured',
  huaweicloud_secret_delete: 'structured',
  huaweicloud_packs_configure: 'structured',
};

// The client-facing permission action opencode namespaces a roster tool
// under: `<mcp server key>_<tool>`, the key being our `.mcp.json` server name
// (measured on 2.2.7, and byte-identical across the 1.19 V1 key and the 2.x
// permission action). One home for the derivation, so the doctor's hygiene
// reader (lib/opencode-saved-perms.ts), the ask-rule writer, and the doctor
// can never drift onto different spellings of the same grant.
export const APPROVAL_MCP_SERVER = 'huaweicloud-devkit';

export function approvalToolAction(tool: string): string {
  return `${APPROVAL_MCP_SERVER}_${tool}`;
}
