// Version-update detection & auto-upgrade for huaweicloud-devkit (session-level).
// Spec: docs/superpowers/specs/2026-09-07-version-upgrade-design.md (internal, not committed).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
  return state;
}
