// The hcloud write-approval posture, resolved from DEVKIT_APPROVAL_MODE.
//
// 'token' (the default) is the out-of-band terminal gate: the plan mints
// an approval token, the user confirms it in their own terminal
// (`npx huaweicloud-devkit approve <uuid>`), and run_approved_command
// consumes the token before executing. 'ask' moves the confirmation onto
// the harness client's own permission prompt: the operator opts in via
// the env var (normally written by the installer together with the
// client's ask rule), and accepting that client prompt IS the user's
// confirmation — no terminal trip, no UUID in the model's context; the
// plan mints nothing and the run needs only approvedByUser.
//
// Resolution is exact-match and fail-loud, mirroring the DEVKIT_PACKS
// unknown-id doctrine: a typo'd mode must not silently fall back to the
// weaker gate, so anything but 'ask' or 'token' throws with the env name
// and the bad value (case included — 'ASK' throws). Unset or empty keeps
// 'token'. The resolver is pure and takes the env as a parameter; every
// reader re-resolves from process.env (the mode is process-stable for the
// life of the process), so there is deliberately no cached module state
// to disagree with a fresh read. The module imports nothing: it feeds
// both the bundled mcp-server graph and the unbundled setup-cli graph.

export type ApprovalMode = 'token' | 'ask';

export const APPROVAL_MODE_ENV = 'DEVKIT_APPROVAL_MODE';

export function approvalModeFromEnv(env: Record<string, string | undefined>): ApprovalMode {
  const raw = env[APPROVAL_MODE_ENV];
  if (raw === undefined || raw === '') return 'token';
  if (raw === 'ask' || raw === 'token') return raw;
  throw new Error(`DEVKIT_APPROVAL_MODE must be "ask" or "token" (got "${raw}")`);
}
