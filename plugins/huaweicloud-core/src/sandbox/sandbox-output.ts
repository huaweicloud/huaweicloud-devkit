// The single escape-stripping seam for sandbox command output (#946), extracted
// from session-manager so every sandbox-output parser entry point — the
// deploy-check parser, the deploy-nginx-verify parser, the upload md5 verify,
// and the devbridge-tunnel family's parser modules (devbridge-auth/expose/
// verify/renew/keepalive) — folds in one copy instead of re-rolling the
// regexes.

// Strip terminal escape sequences from sandbox command output (#946): CSI
// color/cursor codes and OSC shell-integration markers (shells with integration
// enabled wrap EVERY line in \x1b]133;C\x07, which blinds anchored ^DB_...=
// parsers), then normalize \r\n / \r line endings to \n. The single copy —
// every sandbox-output parser entry point (parseDeployCheckOutput,
// parseDeployNginxVerifyOutput, and the devbridge-tunnel parsers) folds this
// in instead of re-rolling the regexes.
// Use new RegExp to avoid ESLint no-control-regex on literal control chars in regex.
export function stripTerminalEscapes(text: unknown): string {
  // Callers pass ws-exec stdout (string | undefined at runtime); a non-string
  // input reads as empty, matching the previous `String(stdout || '')` for the
  // cases that matter (empty/undefined) without Object's default stringification.
  const raw = typeof text === 'string' ? text : '';
  const ESC = '\x1b';
  // CSI: parameter bytes 0x30-0x3F (digits ; : < = > ? — `?` for private modes
  // like \x1b[?2026h, `>` for device attributes), then intermediate bytes
  // 0x20-0x2F (e.g. `\x1b[0 q`), then a letter final. A digits-;-only class
  // leaves ?-prefixed sequences intact, blinding the anchored ^KEY= lookups.
  // Known edge: a malformed/truncated CSI followed by data lets the
  // intermediate class consume one leading data char — fail-closed corruption
  // of that field, still preferable to the unstripped escape blinding the line.
  const csiRe = new RegExp(ESC + '\\[[0-9:;<=>?]*[ -/]*[a-zA-Z]', 'g');
  // OSC analog of the CSI edge below: a mangled/unterminated OSC whose
  // payload swallows a whole marker line strips the marker entirely. The
  // NGINX-VERIFY family is presence-required end to end (the OK/MISSING
  // inversion, interrogate round 2), so a swallow reads as the failure
  // direction there. Recorded residual (interrogate round 3): the
  // devbridge-expose family still carries absence-equals-success fields
  // (DB_MIGRATION, DB_TUNNEL_BODY, DB_QUOTA_ERROR) — a selective swallow
  // of those reads as SUCCESS (a migrated gateway placeholder can compose
  // ok:true with a dead URL); inverting them is the same
  // one-line-per-marker shape as the nginx family, deliberately not done
  // in this task.
  const oscRe = new RegExp(ESC + '\\][^' + ESC + '\x07]*(?:\x07|' + ESC + '\\\\)', 'g');
  return raw
    .replace(csiRe, '')
    .replace(oscRe, '')
    .replace(/\r\n|\r/g, '\n');
}
