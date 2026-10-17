import { spawnSync } from 'node:child_process';

import { compareVersion, getKooCliVersion, parseHcloudVersion } from './koocli-version.ts';
import { redactSecrets } from './safety-policy.ts';
import { DEPENDENCIES } from './lib/dependency-model.ts';
import { resolveDependencyCommand } from './lib/dep-resolve.ts';

const VERSION_RE = /KooCLI|Current.*version|当前KooCLI/i;

export interface HcloudCommandOptions {
  executable?: string;
  executableArgs?: unknown;
}

export interface HcloudCommand {
  executable: string;
  argsPrefix: string[];
}

export interface HcloudProbeResultLike {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { code?: unknown; message?: unknown } | null;
}

export interface HcloudProbeClassification {
  status: string;
  installed: boolean;
  ok: boolean;
  errorCode?: string;
  installedVersion?: string | null;
  requiredVersion?: string;
  versionMismatch?: boolean;
}

export interface ProbeHcloudOptions {
  executable?: string;
  executableArgs?: unknown;
  timeoutMs?: number;
  requiredVersion?: string | null;
}

// Delegates to the shared resolution chain (lib/dep-resolve.ts) over the
// DEPENDENCIES.hcloud data, so install-time provisioning and spawn-time
// resolution agree on which binary runs. Two deliberate changes versus the
// previous local implementation, both reviewed fixes: unix candidates now
// include /usr/local/bin/hcloud (the macOS install target, previously
// reachable only via PATH), and '~' expands against env.HOME || homedir()
// on unix (the sidecar's hermetic-test convention, now the one rule).
export function findHcloudBin(): string | null {
  const resolved = resolveDependencyCommand(DEPENDENCIES.hcloud.resolution);
  return resolved ? resolved.command : null;
}

function envHcloudArgs(): string[] {
  if (!process.env.HCLOUD_BIN_ARGS_JSON) return [];
  try {
    const parsed: unknown = JSON.parse(process.env.HCLOUD_BIN_ARGS_JSON);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    // malformed HCLOUD_BIN_ARGS_JSON safely collapses to no extra args prefix
  }
  return [];
}

export function resolveHcloudCommand(options: HcloudCommandOptions = {}): HcloudCommand {
  return {
    executable: options.executable || findHcloudBin() || 'hcloud',
    argsPrefix: Array.isArray(options.executableArgs)
      ? options.executableArgs.map((item) => String(item))
      : envHcloudArgs(),
  };
}

export function classifyHcloudProbe(
  result: HcloudProbeResultLike,
  requiredVersion: string | null = getKooCliVersion(),
): HcloudProbeClassification {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const output = `${stdout}${stderr}`;
  const installedVersion = parseHcloudVersion(output);

  if (result.error?.code === 'ENOENT') {
    return {
      status: 'not_found',
      installed: false,
      ok: false,
      errorCode: 'HCLOUD_NOT_FOUND',
    };
  }

  if (result.status === 0 && (VERSION_RE.test(output) || installedVersion)) {
    const versionMismatch = !!(
      requiredVersion &&
      installedVersion &&
      compareVersion(installedVersion, requiredVersion) !== 0
    );
    return {
      status: versionMismatch ? 'version_mismatch' : 'ok',
      installed: true,
      ok: true,
      installedVersion,
      requiredVersion: requiredVersion || undefined,
      versionMismatch,
    };
  }

  if (/获取当前用户家目录失败|home\s+directory|user\s+home|home\s+dir|homedir/i.test(output)) {
    return {
      status: 'sandbox_home_failure',
      installed: true,
      ok: false,
      errorCode: 'HCLOUD_SANDBOX_HOME_FAILURE',
    };
  }

  if (
    /同意并继续使用|不同意并退出|隐私协议|隐私声明|privacy agreement|privacy statement|invalid character|无效字符/i.test(
      output,
    )
  ) {
    return {
      status: 'privacy_pending',
      installed: true,
      ok: false,
      errorCode: 'HCLOUD_PRIVACY_PENDING',
    };
  }

  return {
    status: 'unavailable',
    installed: false,
    ok: false,
    errorCode: 'HCLOUD_UNAVAILABLE',
  };
}

export function probeHcloud(options: ProbeHcloudOptions = {}) {
  const { executable, argsPrefix } = resolveHcloudCommand(options);
  const r = spawnSync(executable, [...argsPrefix, 'version'], {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 5000,
  });
  const classified = classifyHcloudProbe(r, options.requiredVersion);
  const stdout = redactSecrets(String(r.stdout || '').trim());
  const stderr = redactSecrets(String(r.stderr || r.error?.message || '').trim());
  return {
    executable,
    exitCode: r.status,
    stdout,
    stderr,
    output: classified.ok ? stdout : stderr || stdout,
    ...classified,
  };
}

export function hcloudProbeNextStep(probe: HcloudProbeClassification): string {
  if (probe.status === 'ok')
    return 'Use huaweicloud_show_profile_redacted to inspect the active KooCLI profile safely.';
  if (probe.status === 'version_mismatch') {
    return `KooCLI version mismatch: installed ${probe.installedVersion}, this plugin is paired with ${probe.requiredVersion}. Reinstall the pinned version (see huaweicloud-cli-and-auth skill) and restart the agent.`;
  }
  if (probe.status === 'sandbox_home_failure') {
    return 'KooCLI was found, but this agent sandbox cannot resolve the Windows user home directory. Set HCLOUD_BIN to the full hcloud path, restart Codex, or verify from a normal terminal.';
  }
  if (probe.status === 'privacy_pending') {
    return 'KooCLI requires accepting its one-time privacy agreement. Run hcloud version in a real terminal and accept the prompt, then restart the agent.';
  }
  if (probe.status === 'not_found') {
    return 'hcloud executable not found. Set HCLOUD_BIN to the full hcloud path, or install KooCLI: npx huaweicloud-devkit install-hcloud. Then restart the agent.';
  }
  return 'Install Huawei Cloud KooCLI: npx huaweicloud-devkit install-hcloud. Configure credentials outside the agent conversation.';
}
