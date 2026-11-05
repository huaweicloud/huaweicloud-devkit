import {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_MIGRATION_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
  escapeTunnelDomainForRegExp,
} from './devbridge-gateway.ts';
import { DEVBRIDGE_HOST_EXPIRY_HOURS, evaluateDevbridgeVersion } from './devbridge-validation.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { runOneShot, type OneShotResult } from './devbridge-exec.ts';
import type { DevbridgeQuotaKeyHint } from './devbridge-key.ts';

// The expose attempt contract, extracted from devbridge-tunnel: the script that
// starts the host and probes reachability, the DB_* stdout grammar (readDbField
// + the expose/probe parsers), the reachability warning, and the tool's result
// interface. readDbField is the grammar's canonical home — the renew and
// keepalive parsers import it from here.

export interface ExposeTunnelResult {
  ok: boolean;
  publicUrl?: string;
  port: number;
  tunnelId?: string;
  authMode: string;
  httpCode?: string;
  verifyHttpCode?: string;
  verifyNotFound?: boolean;
  persistent?: boolean;
  expiresAt?: string;
  expiresInHours?: number;
  sandboxLifetime?: {
    poolType: string;
    idleShutdownMinutes: number;
    idleDeleteMinutes?: number;
    reclaimMinutes?: number;
  };
  urlLifetimeHint?: string;
  warnings?: string;
  hostLog?: string;
  error?: string;
  error_code?: string;
  version?: string;
  remediation?: string;
  keepalive?: {
    enrolled: boolean;
    tunnelCount: number | undefined;
    watchdogPid: string | undefined;
    logPath: string | undefined;
    error: string | undefined;
  };
  attempts?: Record<string, string>;
  hint?: string;
  loginOutput?: string;
  // The quota-degradation key list (the HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED
  // failure only): masked keys with last_used_at so the caller can pick what
  // to clean up in the console.
  currentKeys?: DevbridgeQuotaKeyHint[];
}

// Start (or replace) a devbridge host bound to a single port, extract the public
// URL, and health-check it. Mirrors the huaweicloud-sandbox skill's Expose flow:
// pre-clean stale tunnels (quota 10006), start host in background, read the
// port-anchored "Tunnel URL: ..." from /tmp/host.log, curl-check, retry once on
// unreachable.
// The host MUST survive the exec session that started it (#919): setsid detaches
// it from the session's process group, `< /dev/null` drops the controlling tty
// stdin, and `disown` removes it from the shell's job table — without all three
// the host is reaped when the one-shot session ends and the tunnel dies
// immediately after a green in-session health check (the "假成功" bug).
export function buildDevbridgeExposeScript(port: number, expiryHours: number = DEVBRIDGE_HOST_EXPIRY_HOURS): string {
  const hostLog = '/tmp/host.log';
  // Port-anchored URL extraction: a multi-port host prints one "Tunnel URL:" line per
  // port, so a port-blind `sed | tail -1` can pick another port's URL. The pattern is
  // derived from the shared domain constant, never hardcoded.
  const domainLiteral = escapeTunnelDomainForRegExp(DEVBRIDGE_TUNNEL_DOMAIN);
  return [
    // #999: the export rides the same first line as the pkill so the fake's
    // first-line recognizer (and any reader) sees one stable anchor — the
    // one-shot exec shell does NOT inherit the auth probe's PATH, and after
    // the Layer-3 install + dedup (or a reboot) the only surviving binary
    // lives at /workspace/.local/bin.
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "devbridge host" 2>/dev/null || true`,
    `sleep 2`,
    `devbridge delete-all > /dev/null 2>&1 || true`,
    // #922 (S8): setsid is unavailable on some sandbox images — fall back to a
    // bare nohup launch so the host still starts; persistence is then judged by
    // the independent re-verify in exposeTunnel, which emits the 请勿分享 warning
    // in the non-persistent case. disown is guarded: shells without the builtin
    // must not abort the script.
    `if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & else nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    // A2 (#935), v2-hardened: bounded URL-extraction retry instead of a flat
    // settle sleep — the host logs "Tunnel URL:" at its own pace (v2's old
    // 12s flat window existed for slow host logs), so re-grep up to 4 times
    // with 3s gaps (0/3/6/9s, early exit) before concluding the host never
    // logged a URL. Main's A2 uses a flat sleep 6 + single grep, which halves
    // the window v2 tuned for slow hosts — deliberate divergence, recorded.
    `TUNNEL_URL=""`,
    `for i in 1 2 3 4; do`,
    `  TUNNEL_URL=$(grep -oE "https://[A-Za-z0-9_-]+-${port}\\.${domainLiteral}" ${hostLog} | head -1)`,
    `  [ -n "$TUNNEL_URL" ] && break`,
    `  sleep 3`,
    `done`,
    // A2 (#935): probe with retries + backoff — 502/000 before the gateway is
    // ready is not a failure; the LAST probe decides reachability. Every probe
    // that receives an HTTP response rewrites the body file; a transport-failed
    // final probe leaves the previous body (inert — body verdicts are
    // status-gated on 404/502, never 000).
    // No `|| echo "000"`: curl's -w already prints 000 on transport-level
    // failure (DNS/refused/timeout) and exits non-zero, so `|| echo` appends a
    // second 000 to the captured output — a value no '000' sentinel check ever
    // equals. Early curl exits leave the field '' or '000' — both are handled
    // as unreachable.
    `HTTP_CODE="000"`,
    `if [ -n "$TUNNEL_URL" ]; then`,
    `  for i in 1 2 3 4; do`,
    // #1000: --noproxy — the sandbox injects an HTTP proxy that does NOT route
    // the tunnel domain; without it the probe returns 502/404 fakes and a
    // working tunnel is judged dead.
    `    HTTP_CODE=$(curl -s --noproxy '*' -o /tmp/.db_probe_body -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null)`,
    `    echo "DB_PROBE_$i=$HTTP_CODE"`,
    `    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then break; fi`,
    `    if [ "$i" != "4" ]; then sleep 5; fi`,
    `  done`,
    `fi`,
    `echo "DB_HOST_LOG="`,
    `tail -n 5 ${hostLog}`,
    `echo "DB_TUNNEL_URL=$TUNNEL_URL"`,
    `echo "DB_HTTP_CODE=$HTTP_CODE"`,
    `echo "DB_EXPIRY_HOURS=${expiryHours}"`,
    // First 64 bytes of the probe body (non-sensitive, newlines stripped so an
    // app body can never line-inject later DB_ verdict fields) — feeds the
    // exact gateway-error body matching.
    `echo "DB_TUNNEL_BODY=$(head -c 64 /tmp/.db_probe_body 2>/dev/null | tr -d '\\r\\n')"`,
    `rm -f /tmp/.db_probe_body`,
    // grep -c prints its 0 count itself on no-match (exit 1); `|| true` keeps
    // that stdout. A missing log leaves '' → parsed as no quota error. (The old
    // `|| echo 0` doubled the output: a stray second 0 line.)
    `echo "DB_QUOTA_ERROR=$(grep -c '10006' ${hostLog} 2>/dev/null || true)"`,
    // Migration-marker scan scoped to the HOST LOG ONLY (devbridge's own
    // output): the probe body is now echoed (DB_TUNNEL_BODY) for the
    // gateway-error classification, and an app page legitimately containing
    // the marker in its first bytes must not be misdiagnosed as a retired
    // pre-migration gateway placeholder.
    `echo "DB_MIGRATION=$(grep -c '${DEVBRIDGE_MIGRATION_MARKER}' ${hostLog} 2>/dev/null || true)"`,
  ].join('\n');
}

export interface DevbridgeProbe {
  attempt: number;
  httpCode: string;
}

// A2 (#935): parse the probe sequence emitted by buildDevbridgeExposeScript.
// Each probe echo is `DB_PROBE_<n>=<code>`; reachability is decided by the
// LAST probe — intermediate 502/000 probes are gateway-not-ready noise, not
// failures, so they must not leak into the tool's verdict. NB: in production
// the verdict rides the DB_HTTP_CODE field (the loop variable's final value,
// emitted by the script) — finalHttpCode here is a diagnostic/test derivation
// for sequences parsed standalone.
export function parseDevbridgeProbeSequence(stdout: unknown): { probes: DevbridgeProbe[]; finalHttpCode: string } {
  const text = stripTerminalEscapes(stdout);
  const probes: DevbridgeProbe[] = [];
  for (const m of text.matchAll(/^DB_PROBE_(\d+)=(\S*)$/gm)) {
    probes.push({ attempt: Number(m[1]), httpCode: m[2] ?? '' });
  }
  const finalHttpCode = probes.length > 0 ? probes[probes.length - 1]!.httpCode : '';
  return { probes, finalHttpCode };
}

// A2 (#935): the reachability warning must come from the LAST probe's HTTP
// status, not from a single early curl — the old single-shot check warned
// "Tunnel reachable check returned HTTP (expected 200/304)" while the same
// log showed DB_HTTP_CODE=200. 200/304 = no warning; anything else surfaces
// as-is.
export function formatTunnelReachabilityWarning(httpCode: string): string | undefined {
  if (httpCode === '200' || httpCode === '304') return undefined;
  return `Tunnel reachable check returned HTTP ${httpCode || '000'} (expected 200/304). The URL may not be serving yet — the final probe decides.`;
}

export interface DevbridgeExpose {
  tunnelUrl: string;
  httpCode: string;
  quotaError: boolean;
  tunnelId: string;
  expiryHours: number | undefined;
  gatewayTunnelError: boolean;
  badGateway: boolean;
  migration: boolean;
  probes: DevbridgeProbe[];
}

// Anchored `^KEY=value` field reader over stripped multi-line text — the DB_*
// output grammar's single lookup rule, shared by the expose and verify parsers
// (and, through this canonical home, the renew and keepalive parsers).
export function readDbField(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? (m[1] ?? '').trim() : '';
}

// Parse the raw stdout of buildDevbridgeExposeScript into structured fields.
// `gatewayTunnelError` marks a URL the s2 gateway itself reports as dead
// (404 "tunnel not found" / "port not configured") — it can never serve content
// regardless of the app. `badGateway` (502 "bad gateway") means the tunnel is
// alive but the local service on the exposed port is not serving.
export function parseDevbridgeExposeOutput(stdout: unknown): DevbridgeExpose {
  // #946: strip OSC/CSI escapes + \r BEFORE the anchored ^DB_ lookups — otherwise
  // every field is lost on integration-enabled shells and a perfectly good tunnel
  // comes back as ok:true with publicUrl missing (and pointlessly re-built once).
  const text = stripTerminalEscapes(stdout);
  const tunnelUrl = readDbField(text, 'DB_TUNNEL_URL') || (text.match(/TUNNEL_URL:(https:\/\/[^\s]+)/) ?? [])[1] || '';
  const httpCode = readDbField(text, 'DB_HTTP_CODE');
  const body = readDbField(text, 'DB_TUNNEL_BODY');
  // Field-scoped verdicts (never scan the echoed probe body): quota and
  // migration are host-log facts, computed script-side by grepping the log.
  // Count-robust (`> 0`, not `=== '1'`): grep -c prints a LINE count, and a
  // retrying host can log the marker on several lines.
  const quotaError = Number(readDbField(text, 'DB_QUOTA_ERROR')) > 0;
  const migration = Number(readDbField(text, 'DB_MIGRATION')) > 0;
  const domainPattern = escapeTunnelDomainForRegExp(DEVBRIDGE_TUNNEL_DOMAIN);
  const tunnelId =
    (tunnelUrl.match(new RegExp(`^https:\\/\\/([A-Za-z0-9_-]+)-\\d+\\.${domainPattern}`)) ?? [])[1] ?? '';
  const expiryHours = Number(readDbField(text, 'DB_EXPIRY_HOURS')) || undefined;
  // Exact-body match gated on the status code: an app's own 404/502 page is never misjudged.
  const gatewayTunnelError =
    httpCode === '404' && (body === DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER || body === DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER);
  const badGateway = httpCode === '502' && body === DEVBRIDGE_BAD_GATEWAY_MARKER;
  const { probes } = parseDevbridgeProbeSequence(text);
  return { tunnelUrl, httpCode, quotaError, tunnelId, expiryHours, gatewayTunnelError, badGateway, migration, probes };
}

// The no-usable-URL failure verdict of exposeTunnel (the Q2 ruling path):
// build the #998 taxonomy return — too_old (with the deferred version
// read-back) / no_tunnel_url / tunnel_unreachable. The failure shape is the
// flow's verbatim return (moved here, not reworded); the caller passes the
// accumulated warnings array and this phase appends its own before joining.
export async function reportUnusableExpose(args: {
  workspaceId: string;
  username: string;
  port: number;
  authMode: string;
  authVersion: string;
  parsed: DevbridgeExpose;
  exposeFailed: boolean;
  warnings: string[];
  result: OneShotResult;
}): Promise<ExposeTunnelResult> {
  const { workspaceId, username, port, authMode, authVersion, parsed, exposeFailed, warnings, result } = args;
  // #998 read-back: a no-URL failure after retries needs the version in the
  // return body — the gate above catches 0.1.x upfront, but a binary that
  // changed mid-flow (or an empty probe version) lands here, and in the
  // measured incident a single version field would have saved the whole
  // credentials/network/port misdiagnosis. The command reuses the DB_VERSION
  // field grammar (echo + anchored parse through stripTerminalEscapes — the
  // #946 doctrine; a raw stdout read would be OSC-blind on exactly the
  // shells that lose the probe line in the first place).
  let noUrlVersion = authVersion;
  if (parsed.tunnelUrl === '') {
    try {
      const versionResult = await runOneShot(
        workspaceId,
        `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "DB_VERSION=$(devbridge version 2>/dev/null | head -1)"`,
        username,
        15000,
      );
      const readBack =
        stripTerminalEscapes(versionResult.stdout)
          .match(/^DB_VERSION=(.*)$/m)?.[1]
          ?.trim() ?? '';
      noUrlVersion = readBack || authVersion;
    } catch {
      // best-effort: the auth probe's version stands
    }
  }
  const noUrlCheck = evaluateDevbridgeVersion(noUrlVersion);
  if (noUrlCheck.blocked) {
    warnings.push(
      `devbridge version is ${noUrlVersion} — too old to serve tunnels; upgrade per Step 0 before retrying.`,
    );
  }
  // #998 taxonomy: too_old (blocked) / no_tunnel_url (no URL observed —
  // host did not start, or the exec timed out before the log was read) /
  // tunnel_unreachable (URL present, probes exhausted). The timeout-fold
  // case gets its own hedged wording — a timeout lost the observation, it
  // did not prove the host never started.
  const timedOut = exposeFailed && parsed.tunnelUrl === '';
  return {
    ok: false,
    port,
    error: noUrlCheck.blocked
      ? noUrlCheck.error
      : timedOut
        ? 'Failed to expose a working DevBridge tunnel: the expose exec timed out or died before a Tunnel URL could be extracted — host state unknown (see warnings). Retry, or raise timeout_ms.'
        : parsed.tunnelUrl === ''
          ? 'Failed to expose a working DevBridge tunnel: the host log contains no Tunnel URL — the host did not start. Check the hostLog below for the real cause.'
          : 'Failed to expose a working DevBridge tunnel: no reachable public URL after retries.',
    error_code: noUrlCheck.blocked
      ? 'devbridge_too_old'
      : parsed.tunnelUrl === ''
        ? 'no_tunnel_url'
        : 'tunnel_unreachable',
    version: noUrlVersion || undefined,
    authMode,
    httpCode: parsed.httpCode,
    warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
    remediation: noUrlCheck.blocked ? noUrlCheck.remediation : undefined,
    hostLog: String(result.stdout ?? '').slice(0, 400),
  };
}
