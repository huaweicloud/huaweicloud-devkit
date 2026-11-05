import { stripTerminalEscapes } from './sandbox-output.ts';
import { runOneShot } from './devbridge-exec.ts';
import { evaluateDevbridgeVersion } from './devbridge-validation.ts';
import type { ExposeTunnelResult } from './devbridge-expose.ts';
import type { DevbridgeKeyResult, DevbridgeQuotaKeyHint } from './devbridge-key.ts';

// The DevBridge auth waterfall, extracted from devbridge-tunnel so the auth
// probe script, its stdout parser, and (with the devbridge-tunnel
// modularization) the expose flow's auth/version gate form one cohesive auth
// concern. Imports the escape-stripping seam from its canonical home.

// Build a shell snippet that authenticates devbridge via a verified waterfall:
//   Tier 1  keyring API Key  — hwcloud keyring get HW_DEVBRIDGE_API_KEY (platform-injected
//           on hd-space-ai-shell images, or self-injected by devbridge-key.ts; the value
//           goes to STDERR so 2>&1 is mandatory and the devbridge_ prefix filters
//           "(not found)" / error text). A light revive step (restart the D-Bus session
//           bus + re-unlock the keyring daemon, no dnf) retries once when the first read fails.
//   Tier 2  /tmp/hw_api_key  — file channel: written by huaweicloud_sandbox_credentials
//           from HW_API_KEY / the api_key param (user-provided), or by the auto-create
//           fallback (devbridge-key.ts) when keyring injection is unavailable.
// AK/SK login (--access-key/--secret-key) was REMOVED: devbridge authentication is
// now fixed to API Key only (定稿决策，2026-11-04).
// Every tier performs a real `devbridge auth login --api-key` and verifies with
// `auth status` (must print "Logged in"); on failure the waterfall falls through.
// DB_ATTEMPT_* lines are non-sensitive diagnostics for support escalation.
// The HOST orchestrates an auto-create fallback between probe rounds: when the
// first probe returns NO_CREDENTIAL, the host calls ensureDevbridgeKey() and
// injects the key (keyring preferred, file fallback), then runs a second probe.
export function buildDevbridgeAuthProbe(): string {
  return [
    // #999: /workspace/.local/bin FIRST — /workspace is the data disk and
    // survives sandbox reboots; ~/.huawei/bin lives on the system disk and is
    // wiped back to the image state on reboot. Prepended so a stale image
    // binary in /usr/local/bin never wins.
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `export HOME="\${HOME:-/root}"`,
    // #998: probe the version in the SAME exec as the auth waterfall (no extra
    // round trip). A 0.1.x binary can never serve tunnels (migrated gateway)
    // no matter which credential succeeds, so the version is what names the
    // real cause when auth or expose fails.
    `DB_VERSION=$(devbridge version 2>/dev/null | head -1)`,
    `echo "DB_VERSION=\${DB_VERSION}"`,
    `DB_OK=0`,
    `db_login_ok() { devbridge auth status 2>/dev/null | grep -q "Logged in"; }`,
    `db_diag() { echo "DB_ATTEMPT_$1=$2"; }`,
    ``,
    `# ---- Tier 1: API Key from the sandbox keyring (platform auto-injection) ----`,
    `HW_DB_KEY=""`,
    `if command -v hwcloud >/dev/null 2>&1; then`,
    `  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/dbus-session}"`,
    `  HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `  case "$HW_DB_KEY" in`,
    `    "devbridge_"*) : ;;`,
    `    *)`,
    `      # Light revive: bus down or a locked/absent keyring daemon — restart both, retry once.`,
    `      if ! pgrep -x dbus-daemon >/dev/null 2>&1 && command -v dbus-daemon >/dev/null 2>&1; then`,
    `        dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `      fi`,
    `      if command -v gnome-keyring-daemon >/dev/null 2>&1; then`,
    `        pkill -f gnome-keyring-daemon 2>/dev/null || true`,
    `        sleep 1`,
    `        printf '\n' | gnome-keyring-daemon --unlock >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `        HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `      fi`,
    `      case "$HW_DB_KEY" in "devbridge_"*) : ;; *) HW_DB_KEY="";; esac`,
    `      ;;`,
    `  esac`,
    `else`,
    `  db_diag KEYRING "hwcloud-not-installed"`,
    `fi`,
    `if [ -n "$HW_DB_KEY" ]; then`,
    `  devbridge auth login --api-key "$HW_DB_KEY" >/tmp/db_auth.log 2>&1`,
    `  if db_login_ok; then`,
    `    echo "DB_AUTH_MODE=API_KEY_KEYRING"`,
    `    DB_OK=1`,
    `  else`,
    `    db_diag KEYRING "login-failed"`,
    `  fi`,
    `else`,
    `  db_diag KEYRING "no-valid-key"`,
    `fi`,
    ``,
    `# ---- Tier 2: API Key from /tmp/hw_api_key (file channel; auto-injected or user-provided) ----`,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  source /tmp/hw_api_key 2>/dev/null`,
    `  if [ -n "$HW_API_KEY" ]; then`,
    `    devbridge auth login --api-key "$HW_API_KEY" >/tmp/db_auth.log 2>&1`,
    `    if db_login_ok; then`,
    `      echo "DB_AUTH_MODE=API_KEY_FILE"`,
    `      DB_OK=1`,
    `    else`,
    `      db_diag APIKEY_FILE "login-failed"`,
    `    fi`,
    `  else`,
    `    db_diag APIKEY_FILE "no-file"`,
    `  fi`,
    `fi`,
    ``,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  echo "DB_AUTH_MODE=NO_CREDENTIAL"`,
    `fi`,
    `unset HW_DB_KEY HW_API_KEY 2>/dev/null`,
    `devbridge auth status > /tmp/db_status.log 2>&1 || true`,
  ].join('\n');
}

export interface DevbridgeAuth {
  authMode: string;
  attempts: Record<string, string>;
  version: string;
}

// Parse the raw stdout of buildDevbridgeAuthProbe into { authMode, attempts, version }.
// authMode is the LAST DB_AUTH_MODE line; attempts collects the non-sensitive
// DB_ATTEMPT_* diagnostics emitted by tiers that failed and fell through;
// version is the devbridge binary version probed in the same exec (#998).
export function parseDevbridgeAuthOutput(stdout: unknown): DevbridgeAuth {
  // #946: OSC 133 markers precede every line on integration-enabled shells; the
  // anchored ^DB_ATTEMPT_ regexes are blind to them without stripping first.
  const text = stripTerminalEscapes(stdout);
  const modes = text.match(/DB_AUTH_MODE=([A-Z_]+)/g) ?? [];
  const authMode = modes.length > 0 ? ((modes[modes.length - 1] ?? '').split('=')[1] ?? '') : '';
  const attempts: Record<string, string> = {};
  for (const m of text.matchAll(/^DB_ATTEMPT_([A-Z_]+)=(\S+)$/gm)) {
    attempts[m[1] ?? ''] = m[2] ?? '';
  }
  const version = text.match(/^DB_VERSION=(.*)$/m)?.[1]?.trim() ?? '';
  return { authMode, attempts, version };
}

// The auth modes the expose loop accepts. API_KEY_AUTO is the winning verdict
// the host records when its self-heal/auto-create fallback established the
// credential between probe rounds.
const USABLE_AUTH_MODES: ReadonlySet<string> = new Set(['API_KEY_KEYRING', 'API_KEY_FILE', 'API_KEY_AUTO']);

function isUsableAuthMode(mode: string): boolean {
  return USABLE_AUTH_MODES.has(mode);
}

// The key-upgrade injection bundle: every function the host needs to establish
// a DevBridge API Key travels together (a key without its injection script is
// not a representable state). handlers-tunnel.ts passes the real bundle; tests
// pass fakes.
export interface DevbridgeKeyUpgradeDeps {
  ensureDevbridgeKey: (poolType: string | undefined | null) => Promise<DevbridgeKeyResult>;
  recreateDevbridgeKey: (poolType: string | undefined | null) => Promise<DevbridgeKeyResult>;
  buildKeyringInjectScript: (apiKey: string) => string;
  listKeysForQuotaHint: () => Promise<DevbridgeQuotaKeyHint[]>;
}

export interface DevbridgeAuthGateOptions {
  poolType?: string;
  keyUpgrade?: DevbridgeKeyUpgradeDeps;
}

// 配额满（上游 13002 → 429 HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED）的结构化降级提示。
const DEVBRIDGE_KEY_QUOTA_HINT =
  'API Key 数量已达上限。请到控制台清理不再使用的 key：' +
  'https://devstation.connect.huaweicloud.com/space/devbridge/apikey\n' +
  'devkit-* 开头的是插件自动管理的 key（删除后会自动重建），可优先清理其他闲置 key。';

const NO_KEY_HINT =
  'No DevBridge API Key is available in this sandbox. Suggested next steps:\n' +
  '1) Re-run huaweicloud_sandbox_credentials, then retry huaweicloud_sandbox_expose_tunnel.\n' +
  '2) If auto-creation failed due to quota (20 key limit), clean up unused keys at ' +
  'https://devstation.connect.huaweicloud.com/space/devbridge/apikey, then retry.\n' +
  '3) The "attempts" field shows which tiers were tried and why they failed — include it when escalating.';

export type ExposeAuthGate =
  { ok: true; authMode: string; version: string } | { ok: false; failure: ExposeTunnelResult };

// The auth+version gate phase of exposeTunnel: run the auth waterfall probe,
// parse it, and decide whether the expose loop may start at all. Between the
// probe and the verdict the host orchestrates the key-upgrade ladder (dev
// doctrine, 2026-11-04): self-heal first when the keyring tier reports a dead
// cached key (recreate → inject → re-probe), then the generic auto-create
// fallback (ensure → inject → re-probe → API_KEY_AUTO); a quota-exhausted
// create degrades to the structured failure with the currentKeys list. The
// failure shapes are the flow's verbatim returns (moved here, not reworded).
export async function gateExposeAuth(
  workspaceId: string,
  username: string,
  port: number,
  { poolType, keyUpgrade }: DevbridgeAuthGateOptions = {},
): Promise<ExposeAuthGate> {
  const authScript = buildDevbridgeAuthProbe();
  const authResult = await runOneShot(workspaceId, authScript, username, 30000);
  const { authMode, attempts, version: authVersion } = parseDevbridgeAuthOutput(authResult.stdout);

  // #998: version gate BEFORE the expose loop AND before the key-upgrade
  // ladder. A 0.1.x binary can never serve tunnels, so creating a key for it
  // is wasted work — the version check must precede the authMode check: the
  // structured too_old error names the real cause where the auth-failure path
  // would point at credentials.
  const versionCheck = evaluateDevbridgeVersion(authVersion);
  if (versionCheck.blocked) {
    return {
      ok: false,
      failure: {
        ok: false,
        port,
        error: versionCheck.error,
        error_code: 'devbridge_too_old',
        version: authVersion,
        authMode,
        attempts,
        // The combined case (0.1.x AND no usable credential): the version is the
        // permanent blocker and keeps precedence, but the caller must not lose
        // the credential half of the diagnosis.
        remediation:
          versionCheck.remediation +
          (authMode === 'NO_CREDENTIAL' || authMode === ''
            ? ' Note: authMode ' +
              (authMode || '(none)') +
              ' indicates a SEPARATE credential issue — after upgrading, re-run huaweicloud_sandbox_credentials.'
            : ''),
      },
    };
  }

  let effectiveAuthMode = authMode;
  if (!isUsableAuthMode(effectiveAuthMode) && keyUpgrade) {
    // 失效自愈：probe 报 login-failed（key 被删/过期）→ 清缓存 → 重建 → 注入 → 重跑 probe
    if (attempts.KEYRING === 'login-failed') {
      try {
        const { apiKey } = await keyUpgrade.recreateDevbridgeKey(poolType || 'ephemeral');
        await runOneShot(workspaceId, keyUpgrade.buildKeyringInjectScript(apiKey), username, 15000);
        const healResult = await runOneShot(workspaceId, authScript, username, 30000);
        const healParsed = parseDevbridgeAuthOutput(healResult.stdout);
        if (isUsableAuthMode(healParsed.authMode)) {
          effectiveAuthMode = 'API_KEY_AUTO';
        }
      } catch {
        // 自愈失败 → 走泛化降级
      }
    }
    // keyring/文件均无 key → host 调 relay API 自动创建 → 注入沙箱 → 重跑 probe
    if (!isUsableAuthMode(effectiveAuthMode)) {
      try {
        const { apiKey } = await keyUpgrade.ensureDevbridgeKey(poolType || 'ephemeral');
        await runOneShot(workspaceId, keyUpgrade.buildKeyringInjectScript(apiKey), username, 15000);
        const retryResult = await runOneShot(workspaceId, authScript, username, 30000);
        const retryParsed = parseDevbridgeAuthOutput(retryResult.stdout);
        if (isUsableAuthMode(retryParsed.authMode)) {
          effectiveAuthMode = 'API_KEY_AUTO';
        }
      } catch (error) {
        // 自动创建失败（含配额满 13002）→ 结构化降级
        if ((error as { code?: string }).code === 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED') {
          const keysHint = await keyUpgrade.listKeysForQuotaHint();
          return {
            ok: false,
            failure: {
              ok: false,
              port,
              error: (error as Error).message,
              error_code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
              authMode: authMode || 'UNKNOWN',
              attempts,
              currentKeys: keysHint,
              hint: DEVBRIDGE_KEY_QUOTA_HINT,
            },
          };
        }
        // 其他自动创建失败 → 继续走原有降级路径（可能 keyring/file 后续可用）
      }
    }
  }

  if (!isUsableAuthMode(effectiveAuthMode)) {
    // v2 deviation: truncation like hostLog — raw auth output is diagnostics,
    // and the auth script never echoes key values, but bound it anyway.
    const loginOutput = (String(authResult.stdout ?? '') + String(authResult.error ?? '')).slice(0, 400);
    return {
      ok: false,
      failure: {
        ok: false,
        port,
        error: 'DevBridge authentication failed: no usable credential in the sandbox.',
        authMode: authMode || 'UNKNOWN',
        attempts,
        hint: NO_KEY_HINT,
        loginOutput,
      },
    };
  }

  return { ok: true, authMode: effectiveAuthMode, version: authVersion };
}
