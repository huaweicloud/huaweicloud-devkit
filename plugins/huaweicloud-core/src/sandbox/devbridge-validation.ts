import { asText } from '../lib/as-text.ts';

// The DevBridge tunnel parameter policy, extracted from devbridge-tunnel so
// the shell-interpolation validators, the lifetime constants, and the 0.1.x
// version gate have one canonical home in the tunnel family. Pure leaf: the
// script builders, parsers, and flows import from here; this module imports
// nothing but asText.

// Tunnel lifetime for expose-created hosts, in hours. The report that motivated
// #919 uses -e 72 so the shared link survives long after the deploying session
// ends; the value is surfaced to callers via exposeTunnel's expiresAt field.
export const DEVBRIDGE_HOST_EXPIRY_HOURS = 72;

// Upper bound of devbridge's -e expiry, in hours (measured 2026-10: `-e 720` is
// accepted and sets expiration = now + 2592001s; larger values are rejected).
export const DEVBRIDGE_MAX_EXPIRY_HOURS = 720;

// Default renewal horizon for renewTunnel / the keepalive watchdog: 720h gives a
// 29-day window of tolerance if renewal ever stops firing.
export const DEVBRIDGE_RENEW_HOURS = 720;

// Parse and validate a TCP port number destined for shell interpolation. Returns
// the integer when 1..65535; throws otherwise. Guards the `-p ${port}` shell
// splice in buildDevbridgeExposeScript against non-numeric / out-of-range input.
export function validateTunnelPort(port: unknown): number {
  const n = Number(port);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `sandbox expose tunnel: invalid port ${JSON.stringify(port)}. Expected an integer between 1 and 65535 (use the "port" value returned by sandbox_deploy_nginx).`,
    );
  }
  return n;
}

// Validate and clamp a -e expiry value destined for shell interpolation in
// `devbridge host -p <port> -e <hours>` / `devbridge update <id> -e <hours>`.
// devbridge accepts 1..720 (30 days); anything else is rejected or clipped by
// the gateway, so fail fast here instead of surfacing a misleading expiry.
export function validateExpiryHours(hours: unknown): number {
  const n = Number(hours);
  if (!Number.isSafeInteger(n) || n < 1 || n > DEVBRIDGE_MAX_EXPIRY_HOURS) {
    throw new Error(
      `sandbox tunnel expiry: invalid expiry_hours ${JSON.stringify(hours)}. Expected an integer between 1 and ${DEVBRIDGE_MAX_EXPIRY_HOURS} (720 = the devbridge 30-day maximum).`,
    );
  }
  return n;
}

// The tunnel-ID charset as one shared pattern: validateTunnelId guards shell
// splices with it, and the selective-cleanup parsers (devbridge-cleanup.ts)
// recognize real IDs with it. The real CLI accepts only lowercase base32
// (a-z2-7, length 8); this superset over-accepts by design — parsing and
// shell-splice guarding fail SAFE on junk (the CLI's own validation rejects
// any phantom delete; a phantom matching a real hostless tunnel is a
// documented orphan-delete), while a strict pattern would silently DROP real
// IDs on any charset drift.
export const DEVBRIDGE_TUNNEL_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;

// Validate a DevBridge tunnel ID destined for shell interpolation in
// `devbridge update <id>` / `devbridge host <id>` / pgrep patterns. IDs are
// short lowercase base36 tokens (e.g. nv2dvv6w, kag7rozs); the strict charset
// keeps shell metacharacters out of the splice.
export function validateTunnelId(tunnelId: unknown): string {
  const id = asText(tunnelId ?? '');
  if (!DEVBRIDGE_TUNNEL_ID_PATTERN.test(id)) {
    throw new Error(
      `sandbox tunnel: invalid tunnel_id ${JSON.stringify(id.slice(0, 40))}. Expected the short ID from huaweicloud_sandbox_expose_tunnel's "tunnelId" field (URL-safe characters only).`,
    );
  }
  return id;
}

export interface DevbridgeVersionVerdict {
  blocked: boolean;
  error?: string;
  remediation?: string;
}

// #998: 0.1.x binaries cannot serve tunnels — their hardcoded pre-migration
// gateway was retired (Sep 2026) and now serves a「服务已迁移」placeholder,
// while their AK/SK auth tier still logs in successfully. Without a version
// check the auth green-light leads to an expose that fails after retries with
// no version context, sending the caller chasing credentials/network/port
// instead of the real cause. Block 0.1.x BEFORE exposing and point at the
// Step 0 install path. An empty version (binary absent) does not block — the
// auth waterfall handles that case.
export function evaluateDevbridgeVersion(version: unknown): DevbridgeVersionVerdict {
  const v = asText(version ?? '').trim();
  if (!v) return { blocked: false };
  // v?-tolerant: a hypothetical v-prefixed tag must not slip the gate. The
  // terminator class ($|[.-]) is load-bearing — bare ^0\.1 would mis-block a
  // future 0.10.x (semver-newer than 0.2).
  if (/^v?0\.1($|[.-])/.test(v)) {
    return {
      blocked: true,
      error:
        `devbridge_too_old: ${v} cannot serve tunnels — its hardcoded gateway was migrated and now serves a 「服务已迁移」 placeholder. ` +
        'An upgrade to 0.2.x is required before exposing; no credential change will fix this.',
      // v2 divergence from main's remediation: -p /workspace/.local/bin rides
      // the installer invocation (#999) — the data-disk install is the whole
      // point, and main's text teaches the reboot-lossy default.
      remediation:
        'Upgrade in place per the huawei-sandbox skill Step 0: install 0.2.x via the GitCode mirror with GitHub fallback ' +
        '(`install.sh -s -p /workspace/.local/bin -u <gitcode URL> -v <target>`, `-s` is required in the sandbox), then re-run huaweicloud_sandbox_expose_tunnel. ' +
        'Install to /workspace/.local/bin (survives sandbox reboots) — never ~/.huawei/bin (wiped on system-disk reset). ' +
        'Old 0.1.x tunnels do not survive the upgrade: the expose flow pre-cleans them.',
    };
  }
  return { blocked: false };
}
