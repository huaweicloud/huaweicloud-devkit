// The hcloud write-approval posture, resolved from DEVKIT_APPROVAL_MODE.
//
// 'ask' (the default) is the server-run confirmation: the approval gate
// runs the confirmation itself inside the run call — an elicitation form
// on a client that declared the form capability, or the
// ASK_CONFIRMATION_REQUIRED chat round-trip whose retry carries
// approvedByUser. No terminal trip and no UUID in the model's context; the
// plan mints nothing. 'token' is the opt-in out-of-band terminal gate
// (and the only channel on the stateless remote transport, which forces
// it back): the plan mints an approval token, the user confirms it in
// their own terminal (`npx huaweicloud-devkit approve <uuid>`), and
// run_approved_command consumes the token before executing.
//
// Resolution is exact-match and fail-loud, mirroring the DEVKIT_PACKS
// unknown-id doctrine: a typo'd mode must not silently fall back to the
// weaker gate, so anything but 'ask' or 'token' throws with the env name
// and the bad value (case included — 'ASK' throws). Unset or empty keeps
// 'ask'. The resolver is pure and takes the env as a parameter; every
// reader re-resolves from process.env (the mode is process-stable for the
// life of the process), so there is deliberately no cached module state
// to disagree with a fresh read. The module imports nothing: it feeds
// both the bundled mcp-server graph and the unbundled setup-cli graph.

export type ApprovalMode = 'token' | 'ask';

export const APPROVAL_MODE_ENV = 'DEVKIT_APPROVAL_MODE';

export function approvalModeFromEnv(env: Record<string, string | undefined>): ApprovalMode {
  const raw = env[APPROVAL_MODE_ENV];
  if (raw === undefined || raw === '') return 'ask';
  if (raw === 'ask' || raw === 'token') return raw;
  throw new Error(`DEVKIT_APPROVAL_MODE must be "ask" or "token" (got "${raw}")`);
}
