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

function upgradeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isCredentialEnvVarName(key) || UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) continue;
    next[key] = value;
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
// (legacy), with ANSI color, warnings, notices, and log pointers around them.
// The trailing lines are boilerplate, so the reason keeps the identifying code
// line plus the first diagnostic instead of the tail (#1117).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

function normalizeNpmLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE, '')
    .trim()
    .replace(/^npm ERR!\s?/, 'npm error ');
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
    /(?:-debug-\d+\.log|-eresolve-report\.txt)$/.test(payload) ||
    /^\s*at\s/.test(payload)
  );
}

function isNpmStructuredHeader(line: string): boolean {
  const payload = npmPayload(line);
  return payload === '' || /^(?:errno|syscall|code)\b/.test(payload);
}

function extractNpmFailureReason(execResult: SpawnResultLike): string {
  if (execResult.error?.message) return execResult.error.message;
  const lines = String(execResult.stderr || '')
    .split(/\r?\n/)
    .map((line) => normalizeNpmLine(line))
    .filter((line) => line && !isNpmNoiseLine(line));
  const codeLine = lines.find((line) => isNpmErrorLine(line) && /^code \S+/.test(npmPayload(line)));
  const diagnostic = lines.find((line) => isNpmErrorLine(line) && line !== codeLine && !isNpmStructuredHeader(line));
  const kept = [codeLine, diagnostic].filter((line): line is string => Boolean(line));
  if (kept.length) return kept.join(' ');
  const first = lines.find((line) => !isNpmErrorLine(line));
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
