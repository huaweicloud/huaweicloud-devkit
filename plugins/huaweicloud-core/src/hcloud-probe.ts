import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compareVersion, getKooCliVersion, parseHcloudVersion } from './koocli-version.ts';
import { redactSecrets } from './safety-policy.ts';

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
  stdout?: unknown;
  stderr?: unknown;
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

export function findHcloudBin(): string | null {
  if (process.env.HCLOUD_BIN && existsSync(process.env.HCLOUD_BIN)) return process.env.HCLOUD_BIN;
  const candidates =
    process.platform === 'win32'
      ? [join(homedir(), 'hcloud', 'hcloud.exe')]
      : [join(homedir(), '.local', 'bin', 'hcloud'), join(homedir(), 'hcloud', 'hcloud')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  const locator =
    process.platform === 'win32'
      ? spawnSync('where.exe', ['hcloud'], { windowsHide: true, stdio: 'pipe', encoding: 'utf8', timeout: 3000 })
      : spawnSync('sh', ['-c', 'command -v hcloud'], {
          windowsHide: true,
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 3000,
        });
  if (locator.status === 0) {
    const first = String(locator.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  }
  return null;
}

function envHcloudArgs(): string[] {
  if (!process.env.HCLOUD_BIN_ARGS_JSON) return [];
  try {
    const parsed: unknown = JSON.parse(process.env.HCLOUD_BIN_ARGS_JSON);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {}
  return [];
}

export function resolveHcloudCommand(options: HcloudCommandOptions = {}): HcloudCommand {
  return {
    executable: options.executable || findHcloudBin() || 'hcloud',
    argsPrefix: Array.isArray(options.executableArgs) ? options.executableArgs : envHcloudArgs(),
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
