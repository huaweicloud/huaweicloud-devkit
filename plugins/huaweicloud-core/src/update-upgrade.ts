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
  const devkitSpellings: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper === 'HUAWEICLOUD_NPM_REGISTRY') {
      devkitSpellings.push([key, value]);
      continue;
    }
    if (upper === 'NPM_CONFIG_REGISTRY') registrySpellings.push(key);
    if (UPGRADE_PRESERVE_ENV_KEYS.has(upper)) {
      next[key] = value;
      continue;
    }
    if (isCredentialEnvVarName(key) || UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS.has(upper)) continue;
    next[key] = value;
  }
  // Pathological case spellings: the trimmed non-empty exact-case key wins,
  // else the first trimmed non-empty spelling; empty and whitespace count as
  // unset everywhere. One canonical channel, so the child's own devkit lookup
  // and npm's pin cannot disagree, and an unset override never pins.
  const nonEmpty = devkitSpellings.filter(([, value]) => Boolean(value?.trim()));
  const registry = (nonEmpty.find(([key]) => key === 'HUAWEICLOUD_NPM_REGISTRY') ?? nonEmpty[0])?.[1]?.trim();
  if (registry) {
    next.HUAWEICLOUD_NPM_REGISTRY = registry;
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
// code line plus the human diagnostic (#1117).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const LOG_POINTER_SUFFIX =
  /\s*(?:npm error\s+)?(?:A complete log of this run can be found in:|For a full report see:).*$/;
const DIAGNOSTIC_HINT = /\b[A-Za-z]*Error\b|\b(?:failed|failure|fatal|unknown|unsupported)\b|错误|失败|不支持|未知/i;
// Error-name starts: Error, TypeError, RangeError, ReferenceError, SyntaxError,
// and the bracketed dump header `[TypeError: ...] {`.
const ERROR_NAME = /^(?:\[?[A-Za-z]*Error\b|fatal\b|FATAL\b)/;
// Progress vocabulary that looks like an errno token (E + word) but is not
// one. Stems so inflections (EXTRACTED, EXPORTING, EVALUATING) match too.
const NON_ERRNO_E_STEMS = [
  'ENABL',
  'ENFORC',
  'ESBUILD',
  'EVENT',
  'EVALUAT',
  'EXEC',
  'EXIT',
  'EXPORT',
  'EXTRACT',
  'EMAIL',
  'END',
  'EVS',
  'E2E',
];
const ERRNO_SHAPE = /^E[A-Z0-9][A-Z0-9_]+$/;

function isErrnoToken(token: string | undefined): boolean {
  if (!token || !ERRNO_SHAPE.test(token)) return false;
  return !NON_ERRNO_E_STEMS.some((stem) => token.startsWith(stem));
}

function stripLogPointerSuffix(line: string): string {
  return line.replace(LOG_POINTER_SUFFIX, '').trim();
}

function shiftNpmErrorToken(line: string): string {
  const errorAt = line.search(/npm error\b/);
  if (errorAt === 0) return line;
  if (errorAt > 0 && /^[^\x21-\x7e]*$/.test(line.slice(0, errorAt))) return line.slice(errorAt);
  // npm 9 under a pty glues progress text before the legacy token; nothing
  // printable there is a diagnostic of its own, so the token still moves.
  const legacyAt = line.search(/npm ERR!/);
  return legacyAt > 0 ? line.slice(legacyAt) : line;
}

function normalizeNpmLine(line: string): string {
  const shifted = shiftNpmErrorToken(line.replace(ANSI_ESCAPE, '').trim());
  return stripLogPointerSuffix(shifted.replace(/^npm ERR!\s?/, 'npm error '));
}

function npmPayload(line: string): string {
  return line.replace(/^npm error\s*/, '');
}

function isNpmErrorLine(line: string): boolean {
  return /^npm error\b/.test(line);
}

// A pointer line carries nothing but the npm log path (optionally behind a
// label); a sentence that mentions the path keeps its content.
function isPointerOnlyLine(line: string): boolean {
  const payload = npmPayload(line)
    .trim()
    .replace(/^[A-Za-z][\w .-]*:\s*/, '');
  if (!/(?:-debug(?:-\d+)?\.log|-eresolve-report\.txt)$/.test(payload)) return false;
  return /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])/.test(payload);
}

// Frames: `at`, optional async/new, then a token that ends in a call or a
// location. A sentence that merely opens with "at least" does not match.
const STACK_FRAME = /^\s*at\s+(?:async\s+|new\s+)?\S+(?:\s*\(|:\d+:\d+\b)/;

function isNpmNoiseLine(line: string): boolean {
  if (/^(?:npm warn\b|npm notice\b|\(node:\d+\))/i.test(line)) return true;
  if (/DeprecationWarning|trace-deprecation/i.test(line)) return true;
  const payload = npmPayload(line);
  return (
    /^A complete log of this run can be found in:/.test(payload) ||
    /^For a full report see:/.test(payload) ||
    /^Log files were not written due to an error writing to the directory:/.test(payload) ||
    /^You can rerun the command with `--loglevel=verbose`/.test(payload) ||
    isPointerOnlyLine(line) ||
    STACK_FRAME.test(payload)
  );
}

// Tiers: a strong failure marker, then failure words, then the plain position
// tier, and metadata last. The strongest tier takes its later line (a fatal
// line lands after a retry marker), the hint tier its earlier one (the real
// failure precedes cleanup chatter), and the position tier the later line in
// the codeless branch.
function lineRank(line: string): number {
  const payload = npmPayload(line);
  if (ERROR_NAME.test(payload)) return 0;
  const token = /^([A-Z0-9_]+)(?=:|\s)/.exec(payload)?.[1];
  if (isErrnoToken(token)) return 0;
  for (const match of payload.matchAll(/(?<=:\s)(E[A-Z0-9][A-Z0-9_]+)\b/g)) {
    if (isErrnoToken(match[1])) return 0;
  }
  if (!payload || /^(?:errno|syscall|path|code|command failed)\b/.test(payload)) return 3;
  if (/^\s*[A-Za-z_]\w*:\s*(?:'[^']*'|"[^"]*"|-?\d+|\[[^\]]*\])\s*,?\s*$/.test(payload)) return 3;
  if (DIAGNOSTIC_HINT.test(payload)) return 1;
  return 2;
}

function selectFailureLine(
  lines: string[],
  { positionLast }: { positionLast: boolean },
): { line: string; rank: number } | undefined {
  for (const rank of [0, 1, 2, 3]) {
    const hits = lines.filter((line) => lineRank(line) === rank);
    if (!hits.length) continue;
    const later = rank === 0 || (rank === 2 && positionLast);
    return { line: (later ? hits.at(-1) : hits[0])!, rank };
  }
  return undefined;
}

function extractNpmFailureReason(execResult: SpawnResultLike): string {
  if (execResult.error?.message) return execResult.error.message;
  const lines = String(execResult.stderr || '')
    .split(/\r?\n/)
    .map((line) => normalizeNpmLine(line))
    .filter((line) => line && !isNpmNoiseLine(line));
  const codeLine = lines.find((line) => isNpmErrorLine(line) && /^code \S+/.test(npmPayload(line)));
  const others = lines.filter((line) => isNpmErrorLine(line) && line !== codeLine);
  const codeless = lines.filter((line) => !isNpmErrorLine(line));
  const block = selectFailureLine(others, { positionLast: false });
  const bare = selectFailureLine(codeless, { positionLast: true });
  // Both branches compete: an unprefixed crash line outranks a block echo, and
  // the block keeps its code prefix only when the block itself wins.
  if (bare && (!block || bare.rank < block.rank)) return bare.line;
  if (block) return [codeLine, block.line].filter((line): line is string => Boolean(line)).join(' ');
  if (codeLine) return codeLine;
  if (bare) return bare.line;
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
