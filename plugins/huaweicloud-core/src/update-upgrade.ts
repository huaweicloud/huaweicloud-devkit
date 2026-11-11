// The upgrade act: elects the target tag (latest/next), spawns
// `npx huaweicloud-devkit@<tag> update --target <target>`, and shapes the
// restart/manual-command guidance. Part of the src/update-* family behind the
// src/update-check.ts re-export face.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { isCredentialEnvVarName } from './lib/secret-vault/refs.ts';
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import { readInstalledVersion } from './update-installed.ts';
import { queryDistTags, errorMessage } from './update-registry.ts';
import { invalidateUpdateCache } from './update-cache.ts';

const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// The upgrade child is arbitrary registry code and the published package needs
// no account, so it gets an environment without the credential family the
// vault predicate owns (case-normalized, so a Windows spelling cannot survive),
// plus dev 4890d78c's AWS keys and KooCLI's `HUAWEI_*` alias spellings, which the
// predicate does not claim.
const UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'HUAWEI_ACCESS_KEY',
  'HUAWEI_SECRET_KEY',
]);

// The predicate's prefixes also cover the devkit's own configuration. These
// names are read by the child's update graph (registry, proxy, state root,
// binary resolution, install skips), so they pass through unchanged.
const UPGRADE_PRESERVE_ENV_KEYS = new Set([
  'HCLOUD_BIN',
  'HCLOUD_BIN_ARGS_JSON',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_META_DIR',
  'HCLOUD_OBS_CONFIG_PATH',
  'HUAWEICLOUD_DEVKIT_DEBUG',
  'HUAWEICLOUD_DEVKIT_HOME',
  'HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL',
  'HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT',
  'HUAWEICLOUD_DEVKIT_SKIP_UPDATE',
  'HUAWEICLOUD_DEVKIT_TELEMETRY',
  'HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT',
  'HUAWEICLOUD_HOME',
  'HUAWEICLOUD_ICONS_OFFLINE',
  'HUAWEICLOUD_INJECT_STS_CMD',
  'HUAWEICLOUD_MCP_POLICY_FILE',
  'HUAWEICLOUD_NPM_REGISTRY',
  'HUAWEICLOUD_OPENCODE_PERMISSION_SEAM',
  'HUAWEICLOUD_REGION',
  'HUAWEICLOUD_VENDOR_CHALLENGE',
  'HW_IAM_ENDPOINT',
  'HW_POOL_TEMPLATE_EPHEMERAL',
  'HW_POOL_TEMPLATE_PERSISTENT',
  'HW_REGION',
  'HW_SANDBOX_POOL_CACHE_PATH',
  'HW_STS_EXPIRES_AT',
  'HW_WORKSPACE_ID',
]);

function upgradeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  const registrySpellings: string[] = [];
  let registry: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper === 'HUAWEICLOUD_NPM_REGISTRY') registry = value;
    if (upper === 'NPM_CONFIG_REGISTRY') registrySpellings.push(key);
    if (UPGRADE_PRESERVE_ENV_KEYS.has(upper)) {
      next[key] = value;
      continue;
    }
    if (isCredentialEnvVarName(key) || UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS.has(upper)) continue;
    next[key] = value;
  }
  // Dev 4890d78c's pin, scoped to the operator's devkit mirror: when it is set,
  // every npm registry spelling collapses to it; when it is unset, npm's own env
  // and .npmrc channels reach the child untouched.
  if (registry?.trim()) {
    for (const key of registrySpellings) delete next[key];
    next.npm_config_registry = registry;
  }
  return next;
}

interface SpawnResultLike {
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string } | null;
}

type UpgradeSpawnFn = (
  _command: string,
  _args: readonly string[],
  _options: SpawnSyncOptionsWithStringEncoding,
) => SpawnResultLike;

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnResultLike {
  // The args join into the command string before the spawn: options carries
  // shell:true (the #643 npm.cmd routing; the target interpolation stays
  // guarded by the SUPPORTED_AGENT_TARGETS allowlist, review #717), and an
  // args array under shell is DEP0190 on Node 24. shell:true already
  // concatenates args unescaped, so the join is behavior-identical minus
  // the warning; the seam's (command, args) contract is unchanged for the
  // injected test doubles.
  return spawnSync([command, ...args].join(' '), options);
}

// npm reports failures as `npm error ...` lines (npm 7+) or `npm ERR! ...`
// (legacy), with ANSI color, pty spinners, warnings, notices, and log pointers
// around them. The tail is boilerplate, so the reason keeps the identifying
// code line plus the first human diagnostic (#1117).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const LOG_POINTER_SUFFIX =
  /\s*(?:npm error\s+)?(?:A complete log of this run can be found in:|For a full report see:).*$/;
const DIAGNOSTIC_HINT = /\b(?:error|failed|failure|fatal|unknown|unsupported)\b|错误|失败|不支持|未知/i;
// Strong failure markers: an errno-style code token (ENOTFOUND, EACCES, E404) or
// a line that opens with Error/fatal. The CLI convention puts the cause last,
// so ties inside a tier take the later line.
const STRONG_MARKER = /\bE[A-Z][A-Z0-9]{2,}\b|^(?:Error|error|fatal|FATAL)\b/;

function stripLogPointerSuffix(line: string): string {
  return line.replace(LOG_POINTER_SUFFIX, '').trim();
}

function shiftNpmErrorToken(line: string): string {
  const at = line.search(/npm error\b/);
  if (at <= 0) return line;
  // pty spinners write glyph runs, spaces, or cursor escapes before the line;
  // anything printable before the token is the child's own message and stays.
  return /^[^\x21-\x7e]*$/.test(line.slice(0, at)) ? line.slice(at) : line;
}

function normalizeNpmLine(line: string): string {
  const normalized = line
    .replace(ANSI_ESCAPE, '')
    .trim()
    .replace(/^npm ERR!\s?/, 'npm error ');
  return stripLogPointerSuffix(shiftNpmErrorToken(normalized));
}

function npmPayload(line: string): string {
  return line.replace(/^npm error\s*/, '');
}

function isNpmErrorLine(line: string): boolean {
  return /^npm error\b/.test(line);
}

function isNpmNoiseLine(line: string): boolean {
  if (/^(?:npm warn\b|npm notice\b|\(node:\d+\))/i.test(line)) return true;
  if (/DeprecationWarning|trace-deprecation/i.test(line)) return true;
  const payload = npmPayload(line);
  return (
    /^A complete log of this run can be found in:/.test(payload) ||
    /^For a full report see:/.test(payload) ||
    /^\s*.*(?:-debug(?:-\d+)?\.log|-eresolve-report\.txt)$/.test(payload) ||
    /^\s*at\s/.test(payload)
  );
}

// npm's error block leads with metadata fields before the sentence that
// explains the failure. `command sh -c ...` is a last-resort diagnostic: the
// command that failed is better than nothing when the block has no sentence.
function npmDiagnosticRank(line: string): number {
  const payload = npmPayload(line);
  if (payload === '' || /^(?:errno|syscall|path|code|command failed)\b/.test(payload)) return 2;
  if (/^command\b/.test(payload)) return 1;
  return 0;
}

function extractNpmFailureReason(execResult: SpawnResultLike): string {
  if (execResult.error?.message) return execResult.error.message;
  const lines = String(execResult.stderr || '')
    .split(/\r?\n/)
    .map((line) => normalizeNpmLine(line))
    .filter((line) => line && !isNpmNoiseLine(line));
  const codeLine = lines.find((line) => isNpmErrorLine(line) && /^code \S+/.test(npmPayload(line)));
  const others = lines.filter((line) => isNpmErrorLine(line) && line !== codeLine);
  const diagnostic =
    others.find((line) => npmDiagnosticRank(line) === 0) ?? others.find((line) => npmDiagnosticRank(line) === 1);
  const kept = [codeLine, diagnostic].filter((line): line is string => Boolean(line));
  if (kept.length) return kept.join(' ');
  const codeless = lines.filter((line) => !isNpmErrorLine(line));
  const strong = codeless.filter((line) => STRONG_MARKER.test(line));
  const hinted = codeless.filter((line) => DIAGNOSTIC_HINT.test(line));
  const first = strong.at(-1) ?? hinted.at(-1) ?? codeless[0];
  if (first) return first;
  if (execResult.signal) return `signal ${execResult.signal}`;
  if (typeof execResult.status === 'number') return `exit ${execResult.status}`;
  return 'unknown failure';
}

function restartMessage(target: string): string {
  if (target === 'officeace') {
    return '升级完成，请打开连接器 → 我的连接器 → huaweicloud-devkit → 重新连接后使用新版本。';
  }
  return '升级完成，请重启当前会话使新版本生效。';
}

export interface UpgradeOptions {
  doQuery?: () => Promise<DistTags | null>;
  spawnFn?: UpgradeSpawnFn;
  currentVersion?: string;
}

export async function upgradePackage(
  { target = 'all', version = 'latest' }: { target?: string; version?: string } = {},
  options: UpgradeOptions = {},
) {
  if (version !== 'latest') {
    return { success: false, error: 'version 参数仅支持 latest。目标版本由插件自动判定。' };
  }
  // The target is interpolated into an npx command spawned with shell:true;
  // reject anything outside the known agent set + 'all' so a crafted value
  // cannot be interpreted as shell operators (review #717).
  const targetStr = String(target);
  if (targetStr !== 'all' && !SUPPORTED_AGENT_TARGETS.includes(targetStr)) {
    return { success: false, error: `不支持的升级目标：${targetStr}` };
  }
  const { doQuery = queryDistTags, spawnFn = defaultSpawn } = options;
  // Tests inject currentVersion explicitly - the repo package.json version changes
  // between prerelease and stable lines, which must not flip the upgrade-tag logic.
  const previousVersion = options.currentVersion || readInstalledVersion();
  let distTags: DistTags | null;
  try {
    distTags = await doQuery();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  const targetVersion = determineTarget(previousVersion, distTags ?? {});
  if (distTags === null) {
    return {
      success: false,
      error: '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  if (!targetVersion) {
    return { success: false, message: '已是最新版本，无需升级。', requiresRestart: false };
  }
  const isNextTarget = Boolean(distTags.next && semverCompare(targetVersion, distTags.next) === 0);
  const tag = isNextTarget ? 'next' : 'latest';
  const command = ['--yes', `huaweicloud-devkit@${tag}`, 'update', '--target', String(target)];
  let execResult: SpawnResultLike;
  try {
    execResult = spawnFn(NPX_BIN, command, {
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      shell: true,
      env: upgradeEnv(),
    });
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '升级命令执行失败。',
      manual: `npx --yes huaweicloud-devkit@${tag} update --target ${target}`,
    };
  }
  if (execResult.status === 0) {
    invalidateUpdateCache();
    return {
      success: true,
      previousVersion,
      installedVersion: targetVersion,
      requiresRestart: true,
      message: restartMessage(target),
    };
  }
  const reason = extractNpmFailureReason(execResult);
  return {
    success: false,
    error: reason,
    manual: `npx --yes huaweicloud-devkit@${tag} update --target ${target}`,
  };
}
