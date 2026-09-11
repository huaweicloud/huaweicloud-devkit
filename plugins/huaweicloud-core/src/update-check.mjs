// Version-update detection & auto-upgrade for huaweicloud-devkit (session-level).
// Spec: docs/superpowers/specs/2026-09-07-version-upgrade-design.md (internal, not committed).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { fetchWithProxy } from './proxy/proxy-agent.mjs';

const IS_WINDOWS = process.platform === 'win32';
const NPM_BIN = IS_WINDOWS ? 'npm.cmd' : 'npm';
const NPX_BIN = IS_WINDOWS ? 'npx.cmd' : 'npx';
const TTL_MS = 60 * 60 * 1000;
const FAIL_THROTTLE_MS = 5 * 60 * 1000;
const COOLDOWN_DAYS = 3;

export function semverParse(input) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(input).trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, raw: String(input).trim() };
}

function comparePre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // 无 prerelease（正式版）更大
  if (b === null) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNum) {
      return -1; // 数字标识符 < 字母标识符
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function semverCompare(a, b) {
  const A = semverParse(a);
  const B = semverParse(b);
  if (!A || !B) {
    const sa = String(a);
    const sb = String(b);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  }
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  return comparePre(A.pre, B.pre);
}

export function hasPrerelease(v) {
  const parsed = semverParse(v);
  return Boolean(parsed && parsed.pre);
}

export function determineTarget(current, distTags = {}) {
  const isPre = hasPrerelease(current);
  const candidates = [];
  if (distTags.latest) candidates.push(distTags.latest);
  if (isPre && distTags.next) candidates.push(distTags.next);
  if (!candidates.length) return null;
  return candidates.slice().sort(semverCompare).pop();
}

export function parseDistTagsOutput(stdout) {
  try {
    const text = String(stdout || '').trim();
    if (!text) return null; // 空输出视为 npm view 失败
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      next: typeof parsed.next === 'string' ? parsed.next : null,
    };
  } catch {
    return null;
  }
}

function buildResult(current, distTags, extra = {}) {
  const result = {
    currentVersion: current,
    latestStable: distTags?.latest ?? null,
    latestNext: distTags?.next ?? null,
    targetVersion: extra.target ?? null,
    updateAvailable: extra.result === 'update_available',
    dismissed: extra.result === 'dismissed',
    dismissExpiresAt: extra.dismissExpiresAt ?? null,
    result: extra.result ?? 'up_to_date',
  };
  if (extra.note) result.note = extra.note;
  return result;
}

export function judgeUpdate(current, distTags, skipState, now = Date.now()) {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') {
    return buildResult(current, distTags ?? null);
  }
  if (!distTags) {
    return buildResult(current, null, { result: 'check_failed', note: '检测失败，不影响使用' });
  }
  const target = determineTarget(current, distTags);
  if (!target || semverCompare(target, current) <= 0) {
    return buildResult(current, distTags, { result: 'up_to_date', target: target ?? null });
  }
  const expiresAt = skipState?.expireAt ? new Date(skipState.expireAt).getTime() : 0;
  const inCooldown =
    Boolean(skipState) && now < expiresAt && semverCompare(target, String(skipState.dismissedVersion)) <= 0;
  if (inCooldown) {
    return buildResult(current, distTags, { result: 'dismissed', target, dismissExpiresAt: skipState.expireAt });
  }
  return buildResult(current, distTags, { result: 'update_available', target });
}

function selfDir() {
  return dirname(fileURLToPath(import.meta.url));
}

export function readInstalledVersion() {
  const pluginRoot = resolve(selfDir(), '..');
  const packageRoot = resolve(pluginRoot, '..', '..');
  for (const base of [pluginRoot, packageRoot]) {
    try {
      const version = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version;
      if (typeof version === 'string' && version) return version;
    } catch {}
  }
  return null;
}

export function skipFilePath() {
  return join(resolve(selfDir(), '..'), '.update-skip.json');
}

export function fallbackSkipFilePath() {
  const base = process.env.HUAWEICLOUD_HOME || homedir();
  return join(base, '.config', 'huaweicloud', 'devkit-skip.json');
}

// A1 定稿: 标准 agent 用插件目录副本(有 package.json); codex 等无副本时回退共享文件
export function resolveSkipFilePath() {
  try {
    if (existsSync(join(dirname(skipFilePath()), 'package.json'))) return skipFilePath();
  } catch {}
  return fallbackSkipFilePath();
}

export function readSkipState(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.dismissedVersion !== 'string' || !parsed.dismissedAt || !parsed.expireAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSkipState(file, dismissedVersion, { at = Date.now(), days = COOLDOWN_DAYS } = {}) {
  const state = {
    dismissedVersion: String(dismissedVersion),
    dismissedAt: new Date(at).toISOString(),
    expireAt: new Date(at + days * 24 * 60 * 60 * 1000).toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return state;
}

function debugLog(message) {
  if (process.env.HUAWEICLOUD_DEVKIT_DEBUG === '1' || process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true') {
    console.error(`[debug] ${message}`);
  }
}

export function queryDistTagsFetch({ timeoutMs = 15000 } = {}) {
  let registry = 'https://registry.npmjs.org';
  if (process.env.HUAWEICLOUD_NPM_REGISTRY) {
    registry = process.env.HUAWEICLOUD_NPM_REGISTRY.replace(/\/+$/, '');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchWithProxy(`${registry}/-/package/huaweicloud-devkit/dist-tags`)
    .then((resp) => {
      clearTimeout(timer);
      if (!resp || !resp.ok) return null;
      return resp.json().catch(() => null);
    })
    .catch((error) => {
      clearTimeout(timer);
      debugLog(`queryDistTagsFetch: ${error?.message || error}`);
      return null;
    });
}

export function queryDistTagsSync({ timeoutMs = 15000, cwd } = {}) {
  try {
    const result = spawnSync(NPM_BIN, ['view', 'huaweicloud-devkit', 'dist-tags', '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
    });
    if (result.status !== 0) {
      debugLog(`queryDistTagsSync: npm view exited with status ${result.status}`);
      return null;
    }
    return parseDistTagsOutput(result.stdout);
  } catch (error) {
    debugLog(`queryDistTagsSync: ${error?.message || error}`);
    return null;
  }
}

export function queryDistTags({ timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NPM_BIN, ['view', 'huaweicloud-devkit', 'dist-tags', '--json'], {
        windowsHide: true,
        cwd,
      });
    } catch (error) {
      debugLog(`queryDistTags: ${error?.message || error}`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      debugLog(`queryDistTags: timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      debugLog(`queryDistTags: ${error?.message || error}`);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(parseDistTagsOutput(stdout));
      } else {
        debugLog(`queryDistTags: npm view exited with code ${code}`);
        resolve(null);
      }
    });
  });
}

let cachedDistTags = null;
let cachedAt = 0;
let failedAt = 0;
let inflightQuery = null;
let lastHint = null;

export function invalidateUpdateCache() {
  cachedDistTags = null;
  cachedAt = 0;
  failedAt = 0;
  inflightQuery = null;
  lastHint = null;
}

function cacheValid(now = Date.now()) {
  return Boolean(cachedDistTags) && now - cachedAt <= TTL_MS;
}

export async function getCachedUpdateInfo(current, { doQuery = queryDistTags, now = Date.now() } = {}) {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') {
    lastHint = judgeUpdate(current, null, undefined, now);
    return lastHint;
  }
  const skipState = readSkipState(resolveSkipFilePath());
  if (!cacheValid(now)) {
    if (!cachedDistTags && now - failedAt < FAIL_THROTTLE_MS) {
      lastHint = judgeUpdate(current, null, skipState, now);
      return lastHint;
    }
    if (!inflightQuery) {
      inflightQuery = doQuery()
        .then((distTags) => {
          if (distTags) {
            cachedDistTags = distTags;
            cachedAt = now;
          } else {
            failedAt = now;
          }
          return distTags;
        })
        .finally(() => {
          inflightQuery = null;
        });
    }
    const distTags = await inflightQuery;
    lastHint = judgeUpdate(current, distTags, skipState, now);
    return lastHint;
  }
  lastHint = judgeUpdate(current, cachedDistTags, skipState);
  return lastHint;
}

export function peekCachedUpdateInfo() {
  return lastHint && lastHint.updateAvailable && lastHint.targetVersion ? lastHint : null;
}

export async function getUpdateDistTags(current) {
  const result = await getCachedUpdateInfo(current);
  if (!result) return null;
  return { latest: result.latestStable ?? null, next: result.latestNext ?? null };
}

export function applyUpdateHint(result, name, hint) {
  if (!hint || !hint.updateAvailable || !hint.targetVersion) return result;
  if (name === 'huaweicloud_check_update' || name === 'huaweicloud_upgrade') return result;
  return {
    ...result,
    _updateInfo: { currentVersion: hint.currentVersion, latestVersion: hint.targetVersion },
  };
}

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, options);
}

function restartMessage(target) {
  if (target === 'officeace') {
    return '升级完成，请打开连接器 → 我的连接器 → huaweicloud-devkit → 重新连接后使用新版本。';
  }
  return '升级完成，请重启当前会话使新版本生效。';
}

export async function upgradePackage({ target = 'all', version = 'latest' } = {}, options = {}) {
  if (version !== 'latest') {
    return { success: false, error: 'version 参数仅支持 latest。目标版本由插件自动判定。' };
  }
  const { doQuery = queryDistTags, spawnFn = defaultSpawn } = options;
  // Tests inject currentVersion explicitly - the repo package.json version changes
  // between prerelease and stable lines, which must not flip the upgrade-tag logic.
  const previousVersion = options.currentVersion || readInstalledVersion();
  let distTags;
  try {
    distTags = await doQuery();
  } catch (error) {
    return {
      success: false,
      error: error?.message || '无法确认最新版本（registry 查询失败）。',
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
  let execResult;
  try {
    execResult = spawnFn(NPX_BIN, command, { encoding: 'utf8', timeout: 300000, windowsHide: true });
  } catch (error) {
    return {
      success: false,
      error: error?.message || '升级命令执行失败。',
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
