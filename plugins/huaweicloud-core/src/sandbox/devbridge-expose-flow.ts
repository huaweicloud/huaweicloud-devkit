import { DEVBRIDGE_HOST_EXPIRY_HOURS, validateExpiryHours, validateTunnelPort } from './devbridge-validation.ts';
import { runOneShot, type OneShotResult } from './devbridge-exec.ts';
import { gateExposeAuth, type DevbridgeAuthGateOptions } from './devbridge-auth.ts';
import {
  buildDevbridgeExposeScript,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  reportUnusableExpose,
  type DevbridgeExpose,
  type ExposeTunnelResult,
} from './devbridge-expose.ts';
import { verifyTunnelPersistence } from './devbridge-verify.ts';
import { enrollKeepalive, type KeepaliveWatchdogResult } from './devbridge-keepalive.ts';
import { buildExposeLifetimeNotice, type PoolContext } from '../lib/hdkit/sandbox-pool.ts';

// The DevBridge expose-tunnel orchestration, extracted from devbridge-tunnel so
// the tunnel helpers stay a cohesive unit with a pure-function test surface.
// Ported from main's v1.1.8/v1.1.9 session-manager.mjs with two deliberate v2
// deviations (adversarial-review rulings): a final attempt with no usable
// URL returns ok:false instead of ok:true-with-dead-URL, and loginOutput
// is truncated like hostLog (defense-in-depth on diagnostics). A third v2
// ordering deviation: the #919 fresh-session re-verify runs only on the
// usable-URL path — a dead URL already fails above it, so no extra exec is
// spent proving a failure. Ruling on the gateway-error family (documented so
// a future port does not "fix" it): after retry exhaustion, the 404 forms
// ("tunnel not found" / "port not configured") and the migration placeholder
// return ok:false (the gateway itself reports the URL dead), while 502 "bad
// gateway" deliberately returns ok:true-with-warning — the tunnel IS alive,
// the local service is not; the developer needs the URL to debug the service.
//
// The phases live with their concerns and are imported here: the auth/version
// gate from devbridge-auth.ts, the no-URL verdict from devbridge-expose.ts,
// the persistence re-verify from devbridge-verify.ts, and the keepalive
// enrollment from devbridge-keepalive.ts.

// Retry exhausted on a gateway-dead URL (or one pointing at the retired
// pre-migration gateway): such a URL must NOT be handed over as a working
// deployment link — a soft warning here used to read as a success. The
// failure shape is the flow's verbatim return (moved here, not reworded).
function deadUrlExposeFailure(
  gatewayTunnelError: boolean,
  migration: boolean,
  parsed: DevbridgeExpose,
  authMode: string,
  port: number,
  result: OneShotResult,
): ExposeTunnelResult {
  return {
    ok: false,
    port,
    error: gatewayTunnelError
      ? 'DevBridge gateway reports the fresh tunnel URL as dead (404 "tunnel not found" / "port not configured") — the host session is not registered on the gateway. A rebuild was already attempted.'
      : 'DevBridge gateway serves a migration placeholder page (服务已迁移) — the URL points at the retired pre-migration gateway and cannot work.',
    // #998: the migration marker is the 0.1.x signature (the retired
    // gateway is what 0.1.x hardcodes) — this branch preempts the
    // read-back, so the Step-0 remediation rides here directly.
    error_code: migration ? 'devbridge_too_old' : undefined,
    remediation: migration
      ? 'A 0.1.x devbridge produced this URL. Upgrade in place per the huawei-sandbox skill Step 0 (install 0.2.x with -p /workspace/.local/bin), then re-run huaweicloud_sandbox_expose_tunnel.'
      : undefined,
    authMode,
    httpCode: parsed.httpCode,
    hostLog: String(result.stdout ?? '').slice(0, 400),
  };
}

// The keepalive field of the success return: the enrollment summary callers
// read (enrolled / tunnelCount / watchdogPid / logPath / error), or undefined
// when enrollment never ran (opt-out, skip, or failure — failures surface as
// warnings, not here).
function keepaliveResultField(enrollment: KeepaliveWatchdogResult | undefined) {
  return enrollment
    ? {
        enrolled: enrollment.ok === true,
        tunnelCount: enrollment.ok ? (enrollment.tunnels ?? []).length : undefined,
        watchdogPid: enrollment.watchdogPid,
        logPath: enrollment.logPath,
        error: enrollment.ok ? undefined : enrollment.error,
      }
    : undefined;
}

// Expose a sandbox port to a public DevBridge tunnel URL. `port` MUST be the
// ACTUAL port reported by deployNginx (deploy_nginx auto-increments on conflict),
// otherwise the tunnel is bound to a dead port. Returns ok, publicUrl, port,
// tunnelId, auth mode, expiresAt (tunnel lifetime from -e), and warnings; the
// tunnel is re-verified from a second independent exec session (#919) and the
// result carries verifyHttpCode + persistent so callers can tell a
// session-surviving URL from one that dies with the deploying session. v2
// deviation from main: a final attempt that yields no usable URL (empty
// tunnelUrl, or HTTP 000) returns ok:false — main returned ok:true with a dead
// publicUrl, which contradicted the skill's "the returned publicUrl is the
// deployment result" contract.
export async function exposeTunnel(
  workspaceId: string,
  {
    port,
    expiryHours,
    keepalive,
    poolType,
    poolContext,
    keyUpgrade,
  }: {
    port?: number | string;
    expiryHours?: number;
    keepalive?: boolean;
    // DevBridge API Key 自动创建兜底（认证固定 apikey，AK/SK 已移除）：poolType
    // selects which fixed-name key the ladder manages (两池分流，未知归 ephemeral);
    // keyUpgrade is the injected key-lifecycle bundle the gate runs between
    // probe rounds. Omitted by non-production callers (tests) — the gate then
    // degrades to the plain probe verdict.
    poolType?: string;
    // connect 回显缓存的池上下文：仅在成功结果上生成沙箱存活期提示（隧道有效期
    // ≠ 沙箱存活期）；未传/无缓存（自定义模板）时结果不带 sandboxLifetime 字段。
    poolContext?: PoolContext;
    keyUpgrade?: DevbridgeAuthGateOptions['keyUpgrade'];
  },
  username = 'root',
  timeoutMs = 90000,
): Promise<ExposeTunnelResult> {
  if (!workspaceId) {
    throw new Error('sandbox expose tunnel: workspace_id is required.');
  }
  const validatedPort = validateTunnelPort(port);
  const validatedExpiryHours = validateExpiryHours(expiryHours ?? DEVBRIDGE_HOST_EXPIRY_HOURS);

  const gate = await gateExposeAuth(workspaceId, username, validatedPort, { poolType, keyUpgrade });
  if (!gate.ok) {
    return gate.failure;
  }
  const { authMode, version: authVersion } = gate;

  let result: OneShotResult | undefined;
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts) {
    attempt += 1;
    const exposeScript = buildDevbridgeExposeScript(validatedPort, validatedExpiryHours);
    // A2 budget guard: the script's worst case is ~63s of bounded waits
    // (2s settle + up to 9s URL-extraction + 4×10s probes + 3×5s backoff) plus
    // the delete-all round-trip, inside one one-shot exec — a ws-exec timeout
    // here must fold into the unreachable envelope (with the outer rebuild
    // retry) instead of throwing a raw WebSocketExecError out of the tool.
    let exposeFailed = false;
    try {
      result = await runOneShot(workspaceId, exposeScript, username, timeoutMs);
    } catch {
      exposeFailed = true;
      result = { stdout: '', exitCode: 124 };
    }
    const parsed = parseDevbridgeExposeOutput(result.stdout);

    // 10006 quota exceeded: clean up stale tunnels and retry.
    if (parsed.quotaError && attempt < maxAttempts) {
      continue;
    }
    // Unreachable (000 — including a timed-out or failed expose exec), a
    // migrated-gateway placeholder (host-log marker), or gateway-level tunnel
    // errors (404 "tunnel not found" / "port not configured"): one cleanup +
    // rebuild retry. 502 "bad gateway" (host alive, local service down) also
    // gets one retry to cover slow app starts.
    const unreachable = exposeFailed || parsed.httpCode === '000' || parsed.httpCode === '';
    const migration = parsed.migration === true;
    const gatewayTunnelError = parsed.gatewayTunnelError === true;
    const backendDown = parsed.badGateway === true;
    if (unreachable || migration || gatewayTunnelError || backendDown) {
      if (attempt === 1) {
        // best-effort cleanup before the retry; the expose script pre-cleans too.
        try {
          await runOneShot(
            workspaceId,
            // #999: same first-line export as the expose script (the cleanup
            // one-shot is a fresh shell too).
            `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "devbridge host" 2>/dev/null || true; sleep 2; devbridge delete-all > /dev/null 2>&1 || true`,
            username,
            20000,
          );
        } catch {
          // best-effort: cleanup failure must not mask the expose failure
        }
        continue;
      }
      // Retry exhausted: a URL the gateway itself reports as dead (or one pointing
      // at the retired pre-migration gateway) must NOT be handed over as a working
      // deployment link — a soft warning here used to read as a success.
      if (gatewayTunnelError || migration) {
        return deadUrlExposeFailure(gatewayTunnelError, migration, parsed, authMode, validatedPort, result);
      }
    }

    const warnings: string[] = [];
    if (parsed.quotaError)
      warnings.push('DevBridge tunnel quota (10006) hit — stale tunnels were cleaned up and the host was retried.');
    if (parsed.badGateway)
      warnings.push(
        'Tunnel reachable but the gateway reports "bad gateway" — the local service on the exposed port is not serving.',
      );
    if (exposeFailed) {
      warnings.push(
        'The expose script exec failed or timed out — the probe loop never completed; the attempt failed as unobserved (see the error for the timeout taxonomy).',
      );
    }
    // v2 deviation (the Q2 ruling): a final attempt with no usable URL is a
    // failure — ok:true with a dead publicUrl misleads agents into treating
    // the deployment as complete. A migrated gateway serves its placeholder
    // with HTTP 200, so the marker counts as unusable exactly like 000/''.
    const usable = !migration && parsed.tunnelUrl !== '' && parsed.httpCode !== '000' && parsed.httpCode !== '';
    if (!usable) {
      return reportUnusableExpose({
        workspaceId,
        username,
        port: validatedPort,
        authMode,
        authVersion,
        parsed,
        exposeFailed,
        warnings,
        result,
      });
    }

    // A2 (#935): the reachability warning rides the OK path only, from the
    // FINAL probe's HTTP status — the in-script retry loop already absorbed
    // gateway-not-ready 502/000 noise, and the exhausted/unusable path above
    // must not carry "may not be serving yet" retry phrasing.
    const reachabilityWarning = formatTunnelReachabilityWarning(parsed.httpCode);
    if (reachabilityWarning) warnings.push(reachabilityWarning);

    // #919: the persistence re-verify (fresh-session GET, dedicated parser,
    // 请勿分享 warnings) lives in devbridge-verify.ts; v2 ordering — the
    // recheck runs only on this usable-URL path.
    const verification = await verifyTunnelPersistence(workspaceId, parsed.tunnelUrl, username);
    if (verification.warning) warnings.push(verification.warning);

    // 交付地址时必须播报沙箱存活期（隧道有效期 ≠ 沙箱存活期；keepalive 只保隧道不保沙箱）
    const lifetimeNotice = buildExposeLifetimeNotice(poolContext, parsed.expiryHours);
    if (lifetimeNotice) warnings.push(lifetimeNotice.warning);

    const expiresAt =
      parsed.expiryHours !== undefined
        ? new Date(Date.now() + parsed.expiryHours * 3_600_000).toISOString()
        : undefined;
    // AUTO-ENROLL (see the return-shape comment below): read the installed
    // watchdog's tunnel list and merge the new tunnel into it.
    const keepaliveEnrollment = await enrollKeepalive(
      workspaceId,
      { tunnelId: parsed.tunnelId, url: parsed.tunnelUrl },
      keepalive,
      warnings,
      username,
    );

    return {
      ok: true,
      publicUrl: parsed.tunnelUrl,
      port: validatedPort,
      ...(lifetimeNotice
        ? { sandboxLifetime: lifetimeNotice.sandboxLifetime, urlLifetimeHint: lifetimeNotice.urlLifetimeHint }
        : {}),
      tunnelId: parsed.tunnelId || undefined,
      authMode,
      httpCode: parsed.httpCode,
      verifyHttpCode: verification.verifyHttpCode || undefined,
      verifyNotFound: verification.verifyNotFound || undefined,
      persistent: verification.persistent,
      expiresAt,
      expiresInHours: parsed.expiryHours,
      // AUTO-ENROLL: every tunnel exposed through this tool is enrolled into
      // the keepalive watchdog by default (user requirement: all devbridge
      // tunnels deployed to the sandbox must be keepalive-protected —
      // unattended renewal + host re-attach + health check). The new tunnel is
      // MERGED into the existing watchdog tunnel list, never replacing other
      // tunnels' coverage. keepalive:false opts out. Non-fatal: an enrollment
      // failure is surfaced as a warning, not a failed expose — the tunnel
      // itself is working.
      keepalive: keepaliveResultField(keepaliveEnrollment),
      warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
      hostLog: String(result.stdout ?? '').slice(0, 400),
    };
  }

  return {
    ok: false,
    port: validatedPort,
    error: 'Failed to expose a working DevBridge tunnel after retries.',
    authMode,
    hostLog: String(result?.stdout ?? '').slice(0, 400),
  };
}
