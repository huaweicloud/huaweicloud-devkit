import { DEVBRIDGE_RENEW_HOURS, validateExpiryHours, validateTunnelId } from './devbridge-validation.ts';
import { runOneShot } from './devbridge-exec.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { readDbField } from './devbridge-expose.ts';

// The renew family, extracted from devbridge-tunnel: the `devbridge update`
// script, its stdout parser, and the renewTunnel flow. The lifetime policy and
// validators come from devbridge-validation.ts; the DB_* field reader from the
// expose stdout grammar's canonical home.

// Build the script that renews a tunnel's lifetime: `devbridge update <id> -e
// <hours>`. The expiry is a ROLLING WINDOW (measured 2026-10: renewal sets
// expiration = now + hours regardless of remaining time, so renewing before
// expiry keeps the same URL alive indefinitely). The absolute expiration
// (tunnelExpiration, Unix seconds) is surfaced via show -v so callers get a
// verifiable timestamp instead of a bare exit code.
export function buildDevbridgeRenewScript(tunnelId: unknown, expiryHours: unknown = DEVBRIDGE_RENEW_HOURS): string {
  const id = validateTunnelId(tunnelId);
  const hours = validateExpiryHours(expiryHours);
  return [
    // #999: data-disk-first PATH (the surviving binary location) riding the
    // same first line as the update — the standalone-export form is
    // byte-identical to the auth probe's first line (see devbridge-keepalive).
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; devbridge update ${id} -e ${hours} > /tmp/db-renew-update.log 2>&1`,
    `DB_RENEW_EXIT=$?`,
    `DB_RENEW_ERROR=$(head -1 /tmp/db-renew-update.log 2>/dev/null)`,
    `rm -f /tmp/db-renew-update.log`,
    `DB_EXPIRATION=$(devbridge show ${id} -v 2>&1 | grep -oE 'tunnelExpiration[^0-9]+[0-9]+' | grep -oE '[0-9]+' | head -1)`,
    `echo "DB_RENEW_EXIT=$DB_RENEW_EXIT"`,
    `echo "DB_RENEW_ID=${id}"`,
    `echo "DB_RENEW_HOURS=${hours}"`,
    `echo "DB_EXPIRATION=$DB_EXPIRATION"`,
    `echo "DB_RENEW_ERROR=$DB_RENEW_ERROR"`,
  ].join('\n');
}

export interface RenewTunnelResult {
  ok: boolean;
  tunnelId: string;
  renewedForHours: number | undefined;
  expirationUnix: number | undefined;
  expiresAt: string | undefined;
  error: string | undefined;
}

// Parse the raw stdout of buildDevbridgeRenewScript into structured fields.
// A renewal is ok only when the update exit code is 0 AND show -v reports the
// absolute tunnelExpiration — the management plane can lose a tunnel's record
// (10002 "tunnel not found") while the data plane keeps serving, which a bare
// exit-code check would misread as success on the old process alone.
export function parseDevbridgeRenewOutput(stdout: unknown): RenewTunnelResult {
  const text = stripTerminalEscapes(stdout);
  const renewExit = readDbField(text, 'DB_RENEW_EXIT');
  const expirationUnix = Number(readDbField(text, 'DB_EXPIRATION')) || undefined;
  const ok = renewExit === '0' && expirationUnix !== undefined;
  const expiration = expirationUnix !== undefined ? new Date(expirationUnix * 1000).toISOString() : undefined;
  return {
    ok,
    tunnelId: readDbField(text, 'DB_RENEW_ID'),
    renewedForHours: Number(readDbField(text, 'DB_RENEW_HOURS')) || undefined,
    expirationUnix,
    expiresAt: expiration,
    error: ok
      ? undefined
      : readDbField(text, 'DB_RENEW_ERROR') ||
        (renewExit === '0'
          ? 'update succeeded but the absolute expiration could not be read back (management-plane record loss?) — treat as unverified'
          : `renewal failed (exit ${renewExit || 'unknown'})`),
  };
}

// Renew a tunnel's lifetime via `devbridge update <id> -e <hours>`. Returns ok,
// tunnelId, expiresAt (absolute ISO timestamp), renewedForHours. The URL does
// not change — renewal only extends the lifetime of the existing tunnel ID.
export async function renewTunnel(
  workspaceId: string,
  { tunnelId, expiryHours }: { tunnelId?: unknown; expiryHours?: unknown },
  username = 'root',
  timeoutMs = 60000,
): Promise<RenewTunnelResult> {
  if (!workspaceId) {
    throw new Error('sandbox renew tunnel: workspace_id is required.');
  }
  const script = buildDevbridgeRenewScript(tunnelId, expiryHours);
  const result = await runOneShot(workspaceId, script, username, timeoutMs);
  return parseDevbridgeRenewOutput(result.stdout);
}
