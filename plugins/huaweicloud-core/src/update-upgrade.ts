// The upgrade act: elects the target tag (latest/next), spawns
// `npx huaweicloud-devkit@<tag> update --target <target>`, and shapes the
// restart/manual-command guidance. Part of the src/update-* family behind the
// src/update-check.ts re-export face.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import { readInstalledVersion } from './update-installed.ts';
import { queryDistTags, errorMessage } from './update-registry.ts';
import { invalidateUpdateCache } from './update-cache.ts';

const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

interface SpawnResultLike {
  status?: number | null;
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
    execResult = spawnFn(NPX_BIN, command, { encoding: 'utf8', timeout: 300000, windowsHide: true, shell: true });
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
  const errObj = execResult.error;
  const stderr = String(execResult.stderr || '').trim();
  const reason = errObj?.message
    ? errObj.message
    : stderr
      ? stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
      : `exit ${execResult.status}`;
  return {
    success: false,
    error: reason,
    manual: `npx --yes huaweicloud-devkit@${tag} update --target ${target}`,
  };
}
