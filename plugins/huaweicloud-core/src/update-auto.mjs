import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  determineTarget,
  extractNpmFailureReason,
  getRuntimeVersion,
  getVersionPublishTime,
  queryDistTagsFetch,
  readInstalledVersion,
  semverCompare,
  VERSION_MANIFEST_RELS,
} from './update-check.mjs';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SRC_DIR, '..');
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export const AUTO_UPGRADE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPGRADE_FAILURE_THROTTLE_MS = 6 * 60 * 60 * 1000;
export const AUTO_UPGRADE_FORCED_FAILURE_THROTTLE_MS = 60 * 60 * 1000;
export const AUTO_UPGRADE_LOCK_TTL_MS = 30 * 60 * 1000;
const AUTO_UPGRADE_STARTED_NOTICE_MS = 10 * 60 * 1000;
const AUTO_UPGRADE_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

export function autoUpgradePaths(env = process.env) {
  const base = env.HUAWEICLOUD_HOME || homedir();
  const dir = join(base, '.config', 'huaweicloud');
  return {
    dir,
    lock: join(dir, 'devkit-auto-upgrade.lock'),
    state: join(dir, 'devkit-auto-upgrade.json'),
    log: join(dir, 'logs', 'devkit-auto-upgrade.log'),
    backupRoot: join(dir, 'backup', 'devkit-auto'),
  };
}

export function isGitCheckout() {
  try {
    return existsSync(resolve(PLUGIN_ROOT, '..', '..', '.git'));
  } catch {
    return false;
  }
}

function envHome(env = process.env) {
  return env.HUAWEICLOUD_HOME || homedir();
}

function samePath(a, b) {
  const na = resolve(String(a));
  const nb = resolve(String(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isUnder(dir, root) {
  const nd = resolve(String(dir));
  const nr = resolve(String(root));
  const prefix = process.platform === 'win32' ? nr.toLowerCase() : nr;
  const target = process.platform === 'win32' ? nd.toLowerCase() : nd;
  return target === prefix || target.startsWith(`${prefix}${process.platform === 'win32' ? '\\' : '/'}`);
}

// Mirrors the per-agent plugin dirs that `npx huaweicloud-devkit update --target
// all` rewrites (see setup-cli.mjs installMarkerDirForTarget + the update
// targets). `codex` is intentionally absent: the Codex CLI manages its own
// marketplace cache, which this package never rewrites directly. Claude Code
// marketplace installs are likewise outside the write set (no claude target).
export function resolveUpgradeWriteRoots({ env = process.env, home = envHome(env) } = {}) {
  return [
    join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    join(home, 'plugins', 'huaweicloud-devkit'),
    join(home, '.codeartsdoer', 'huaweicloud-plugins'),
    join(home, '.codeartswork', 'huaweicloud-plugins'),
    join(home, '.workbuddy', 'huaweicloud-plugins'),
    join(env.DSH_HOME || join(home, '.dsh'), 'huaweicloud-plugins'),
    join(env.HERMES_HOME || join(home, '.hermes'), 'huaweicloud-plugins'),
    join(home, '.agents', 'huaweicloud-plugins'),
    join(env.ATOMCODE_HOME || join(home, '.atomcode'), 'huaweicloud-plugins'),
    join(env.OFFICE_CLAW_CONFIG_ROOT || join(home, '.office-claw'), 'huaweicloud-plugins'),
  ];
}

function unsupportedInstallManual(pluginRoot, home) {
  if (isUnder(pluginRoot, join(home, '.claude'))) {
    return '当前插件由 Claude Code 插件市场安装，暂不支持自动升级：在 Claude Code 会话中执行 /plugin 更新 huaweicloud-devkit（或更新对应 marketplace）后重启会话';
  }
  if (isUnder(pluginRoot, join(home, '.codex'))) {
    return '当前运行目录来自 Codex 插件缓存，暂不支持自动升级：在终端执行 npx --yes huaweicloud-devkit@latest update --target codex 并重启 Codex 会话';
  }
  return '当前运行目录不在自动升级写入范围：在终端执行 npx --yes huaweicloud-devkit@latest update --target <agent> 后重启会话';
}

// The runner verifies the RUNNING plugin root after `npx update --target all`.
// When the running dir is not one of the directories that update rewrites
// (Claude Code marketplace, Codex CLI cache, unpacked tarballs, global npm
// dirs), the upgrade can only end in verify-fail → rollback → throttle while
// the user is told "upgrade started in the background". Fail fast instead.
export function checkUpgradableInstall({ pluginRoot = PLUGIN_ROOT, env = process.env, home = envHome(env) } = {}) {
  const roots = resolveUpgradeWriteRoots({ env, home });
  if (roots.some((root) => samePath(pluginRoot, root))) return null;
  return { reason: 'unsupported_install', manual: unsupportedInstallManual(pluginRoot, home) };
}

export function autoUpgradeSuppressionReason({ env = process.env, gitCheckout = isGitCheckout() } = {}) {
  if (env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') return 'skip_update';
  const ci = String(env.CI || '').toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'ci';
  if (gitCheckout) return 'git_checkout';
  return null;
}

const UPGRADE_CREDENTIAL_ENV_KEYS = new Set([
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HUAWEICLOUD_ACCESS_KEY',
  'HUAWEICLOUD_SECRET_KEY',
  'HUAWEICLOUD_SECURITY_TOKEN',
  'HUAWEICLOUD_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

export function upgradeEnv(env = process.env) {
  const next = { ...env, npm_config_registry: env.HUAWEICLOUD_NPM_REGISTRY || 'https://registry.npmjs.org' };
  for (const key of UPGRADE_CREDENTIAL_ENV_KEYS) delete next[key];
  return next;
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      pid: Number.isSafeInteger(parsed.pid) ? parsed.pid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

export function isAutoUpgradeLockActive(lockPath, now = Date.now()) {
  if (!existsSync(lockPath)) return false;
  const lock = readLock(lockPath);
  if (lock) {
    const startedAt = lock.startedAt ? Date.parse(lock.startedAt) : NaN;
    const stale = !Number.isFinite(startedAt) || now - startedAt > AUTO_UPGRADE_LOCK_TTL_MS;
    if (stale || !isPidAlive(lock.pid)) {
      try {
        rmSync(lockPath, { force: true });
      } catch {}
      return false;
    }
    return true;
  }
  try {
    const stale = now - statSync(lockPath).mtimeMs > AUTO_UPGRADE_LOCK_TTL_MS;
    if (stale) {
      rmSync(lockPath, { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function acquireAutoUpgradeLock({ lockPath, now = Date.now(), pid = process.pid } = {}) {
  const target = lockPath || autoUpgradePaths().lock;
  if (isAutoUpgradeLockActive(target, now)) return false;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(target, 'wx', 0o600);
    writeSync(fd, JSON.stringify({ pid, startedAt: new Date(now).toISOString() }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
    if (isAutoUpgradeLockActive(target, now)) return false;
    try {
      rmSync(target, { force: true });
      const fd = openSync(target, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date(now).toISOString() }));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseAutoUpgradeLock({ lockPath, pid = process.pid } = {}) {
  const target = lockPath || autoUpgradePaths().lock;
  const lock = readLock(target);
  if (lock && lock.pid !== null && lock.pid !== pid) return false;
  try {
    rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readAutoUpgradeState(statePath) {
  const target = statePath || autoUpgradePaths().state;
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAutoUpgradeState(state, { statePath } = {}) {
  const target = statePath || autoUpgradePaths().state;
  const next = { ...state, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return next;
}

export function getAutoUpgradeNotice({ statePath, runtimeVersion = getRuntimeVersion(), now = Date.now() } = {}) {
  const state = readAutoUpgradeState(statePath);
  if (!state) return null;
  if (state.lastResult === 'succeeded') {
    if (!state.installedVersion) return null;
    if (semverCompare(runtimeVersion, state.installedVersion) >= 0) return null;
    const finishedAt = state.finishedAt ? Date.parse(state.finishedAt) : NaN;
    if (Number.isFinite(finishedAt) && now - finishedAt > AUTO_UPGRADE_NOTICE_TTL_MS) return null;
    return { status: 'succeeded', installedVersion: state.installedVersion, requiresRestart: true };
  }
  if (state.lastResult === 'started') {
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : NaN;
    if (Number.isFinite(startedAt) && now - startedAt <= AUTO_UPGRADE_STARTED_NOTICE_MS) {
      return { status: 'started', targetVersion: state.targetVersion || undefined, requiresRestart: true };
    }
  }
  return null;
}

function isForcedTrigger(trigger) {
  return trigger === 'startup_forced' || trigger === 'version_gate';
}

function failureThrottle(trigger) {
  return isForcedTrigger(trigger) ? AUTO_UPGRADE_FORCED_FAILURE_THROTTLE_MS : AUTO_UPGRADE_FAILURE_THROTTLE_MS;
}

export function decideAutoUpgrade({
  trigger = 'startup_normal',
  current,
  target,
  publishTimeMs = null,
  minVersion = '',
  now = Date.now(),
  state = null,
  diskVersion = current,
} = {}) {
  if (!target) return { action: 'skip', reason: 'no_target' };
  if (minVersion && semverCompare(target, minVersion) < 0) {
    return { action: 'skip', reason: 'registry_behind_min_version', target };
  }
  if (semverCompare(target, current) <= 0) return { action: 'skip', reason: 'up_to_date', target };
  if (diskVersion && semverCompare(diskVersion, target) >= 0) {
    return { action: 'skip', reason: 'already_upgraded', target, installedVersion: diskVersion };
  }
  const forced = isForcedTrigger(trigger);
  if (!forced) {
    if (publishTimeMs === null || publishTimeMs === undefined) {
      return { action: 'skip', reason: 'publish_time_unknown', target };
    }
    if (now - publishTimeMs < AUTO_UPGRADE_COOLDOWN_MS) {
      return { action: 'skip', reason: 'cooldown', target, publishTimeMs };
    }
  }
  if (state?.lastResult === 'failed' && state.targetVersion === target) {
    const at = Date.parse(state.finishedAt || state.startedAt || '');
    if (Number.isFinite(at) && now - at < failureThrottle(trigger)) {
      return { action: 'skip', reason: 'throttled', target };
    }
  }
  return { action: 'upgrade', target };
}

export function maybeAutoUpgrade({
  trigger = 'startup_normal',
  minVersion = '',
  env = process.env,
  now = Date.now(),
  runtimeVersion = getRuntimeVersion(),
  spawnFn = spawn,
  gitCheckout = isGitCheckout(),
  paths = autoUpgradePaths(env),
  state,
  readInstalled = readInstalledVersion,
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  const suppression = autoUpgradeSuppressionReason({ env, gitCheckout });
  if (suppression) return { status: 'disabled', reason: suppression };
  if (!runtimeVersion || runtimeVersion === '0.0.0') {
    return { status: 'disabled', reason: 'unknown_version' };
  }
  const currentState = state === undefined ? readAutoUpgradeState(paths.state) : state;
  const diskVersion = readInstalled() || runtimeVersion;
  if (
    currentState?.lastResult === 'succeeded' &&
    currentState.installedVersion &&
    semverCompare(runtimeVersion, currentState.installedVersion) < 0 &&
    semverCompare(diskVersion, currentState.installedVersion) >= 0
  ) {
    return { status: 'already_upgraded', installedVersion: currentState.installedVersion };
  }
  const unsupported = checkUpgradableInstall({ pluginRoot, env });
  if (unsupported) {
    return { status: 'unsupported_install', trigger, manual: unsupported.manual };
  }
  if (isAutoUpgradeLockActive(paths.lock, now)) return { status: 'already_running' };
  const runnerPath = join(SRC_DIR, 'auto-upgrade-runner.mjs');
  let child;
  try {
    child = spawnFn(
      process.execPath,
      [
        runnerPath,
        '--trigger',
        String(trigger),
        '--min-version',
        String(minVersion || ''),
        '--current-version',
        String(runtimeVersion),
      ],
      { detached: true, stdio: 'ignore', windowsHide: true, env, cwd: PLUGIN_ROOT },
    );
  } catch (error) {
    return { status: 'failed', error: error?.message || String(error) };
  }
  if (child && typeof child.unref === 'function') child.unref();
  return {
    status: 'started',
    trigger,
    currentVersion: runtimeVersion,
    ...(minVersion ? { minVersion } : {}),
  };
}

function logLine(logPath, line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch {}
}

function pruneBackups(backupRoot, keepDir) {
  try {
    const entries = readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const keep = new Set(entries.slice(-2));
    keep.add(keepDir.split(/[\\/]/).pop());
    for (const name of entries) {
      if (keep.has(name)) continue;
      rmSync(join(backupRoot, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch {}
}

// Version-bearing files the snapshot must cover beyond src/: `update` writes
// package.json (installRuntimeDeps) and rewrites the plugin manifests
// (.codex-plugin etc.), and readInstalledVersion falls back to those manifests.
// A rollback that restores src/ but leaves a new-version manifest behind would
// make the next process advertise the new version while running old code —
// exactly the reverse of what the runtime-version snapshot protects against.
const BACKUP_FILE_RELS = ['package.json', ...VERSION_MANIFEST_RELS];

function hashFile(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function hashTree(rootDir) {
  if (!existsSync(rootDir)) return 'missing';
  const lines = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      lines.push(`${prefix}/!unreadable`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) lines.push(`${rel}:${hashFile(join(dir, entry.name))}`);
    }
  };
  walk(rootDir, '');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Fingerprint of everything the snapshot covers: used both to verify the update
// actually rewrote the running dir (not just bumped a version number) and to
// decide whether a rollback really changed anything.
function fingerprintTracked(pluginRoot) {
  const parts = [`src=${hashTree(join(pluginRoot, 'src'))}`];
  for (const rel of BACKUP_FILE_RELS) {
    parts.push(`${rel}=${existsSync(join(pluginRoot, rel)) ? hashFile(join(pluginRoot, rel)) : 'missing'}`);
  }
  return parts.join('|');
}

function backupRunningTarget(pluginRoot, backupRoot, now) {
  const backupDir = join(backupRoot, `${now}-${process.pid}`);
  const src = join(pluginRoot, 'src');
  if (!existsSync(src)) return null;
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  cpSync(src, join(backupDir, 'src'), { recursive: true });
  for (const rel of BACKUP_FILE_RELS) {
    const from = join(pluginRoot, rel);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(backupDir, rel)), { recursive: true });
    copyFileSync(from, join(backupDir, rel));
  }
  pruneBackups(backupRoot, backupDir);
  return backupDir;
}

// Diff-first rollback: report whether anything was actually restored, and copy
// back (or remove) the version files so a failed update can never leave
// "new version in manifests + old src" behind (#1117).
function restoreRunningTarget(pluginRoot, backupDir) {
  if (!backupDir || !existsSync(backupDir)) return false;
  try {
    if (fingerprintTracked(pluginRoot) === fingerprintTracked(backupDir)) return false;
    rmSync(join(pluginRoot, 'src'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    cpSync(join(backupDir, 'src'), join(pluginRoot, 'src'), { recursive: true });
    for (const rel of BACKUP_FILE_RELS) {
      const backupFile = join(backupDir, rel);
      const liveFile = join(pluginRoot, rel);
      if (existsSync(backupFile)) {
        mkdirSync(dirname(liveFile), { recursive: true });
        copyFileSync(backupFile, liveFile);
      } else if (existsSync(liveFile)) {
        rmSync(liveFile, { force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

function verifyInstalled(pluginRoot, target, readInstalled, backupDir) {
  const installed = readInstalled() || '';
  if (!installed || semverCompare(installed, target) < 0) return { ok: false, installed };
  if (!existsSync(join(pluginRoot, 'src', 'mcp-server.mjs'))) return { ok: false, installed };
  // The version number alone can lie (manifest written, src not): require that
  // the update actually rewrote at least one tracked location of THIS dir.
  if (backupDir && existsSync(backupDir) && fingerprintTracked(pluginRoot) === fingerprintTracked(backupDir)) {
    return { ok: false, installed, reason: 'unchanged' };
  }
  return { ok: true, installed };
}

export async function runAutoUpgrade({
  trigger = 'startup_normal',
  minVersion = '',
  currentVersion = getRuntimeVersion(),
  pluginRoot = PLUGIN_ROOT,
  env = process.env,
  now = () => Date.now(),
  doQuery = queryDistTagsFetch,
  doPublishTime = getVersionPublishTime,
  spawnFn = spawnSync,
  paths = autoUpgradePaths(env),
  readInstalled = readInstalledVersion,
  gitCheckout = isGitCheckout(),
} = {}) {
  const suppression = autoUpgradeSuppressionReason({ env, gitCheckout });
  if (suppression) return { lastResult: 'skipped', reason: 'disabled', detail: suppression };
  if (!currentVersion || currentVersion === '0.0.0') {
    return { lastResult: 'skipped', reason: 'unknown_version' };
  }
  // Defense in depth: maybeAutoUpgrade already gates on the write set before
  // spawning this runner; re-check so a stale runner can never run a doomed
  // upgrade → verify-fail → rollback → throttle cycle either.
  const unsupported = checkUpgradableInstall({ pluginRoot, env });
  if (unsupported) {
    return { lastResult: 'skipped', reason: unsupported.reason, manual: unsupported.manual };
  }
  if (!acquireAutoUpgradeLock({ lockPath: paths.lock, now: now() })) {
    return { lastResult: 'skipped', reason: 'locked' };
  }
  try {
    logLine(paths.log, `start trigger=${trigger} current=${currentVersion} min=${minVersion || '-'}`);
    const state = readAutoUpgradeState(paths.state);
    const diskVersion = readInstalled() || currentVersion;
    if (semverCompare(diskVersion, currentVersion) > 0) {
      const skipped = { lastResult: 'skipped', reason: 'already_upgraded', installedVersion: diskVersion };
      logLine(paths.log, `skip already_upgraded installed=${diskVersion}`);
      return skipped;
    }
    let distTags;
    try {
      distTags = await doQuery();
    } catch {
      distTags = null;
    }
    if (!distTags) {
      const failed = writeAutoUpgradeState(
        {
          lastResult: 'failed',
          trigger,
          fromVersion: currentVersion,
          error: 'registry_unavailable',
          startedAt: new Date(now()).toISOString(),
          finishedAt: new Date(now()).toISOString(),
        },
        { statePath: paths.state },
      );
      logLine(paths.log, 'fail registry_unavailable');
      return failed;
    }
    const target = determineTarget(currentVersion, distTags);
    const forced = isForcedTrigger(trigger);
    const publishTimeMs = !forced && target ? await doPublishTime(target, { now: now() }) : null;
    const decision = decideAutoUpgrade({
      trigger,
      current: currentVersion,
      target,
      publishTimeMs,
      minVersion,
      now: now(),
      state,
      diskVersion,
    });
    if (decision.action !== 'upgrade') {
      logLine(paths.log, `skip ${decision.reason} target=${decision.target || '-'}`);
      if (decision.reason === 'throttled' || decision.reason === 'already_upgraded') {
        return { lastResult: 'skipped', ...decision, fromVersion: currentVersion };
      }
      return writeAutoUpgradeState(
        {
          lastResult: 'skipped',
          reason: decision.reason,
          trigger,
          fromVersion: currentVersion,
          targetVersion: decision.target || null,
          finishedAt: new Date(now()).toISOString(),
        },
        { statePath: paths.state },
      );
    }

    const tag = distTags.next && semverCompare(target, distTags.next) === 0 ? 'next' : 'latest';
    const startedAt = new Date(now()).toISOString();
    writeAutoUpgradeState(
      {
        lastResult: 'started',
        trigger,
        fromVersion: currentVersion,
        targetVersion: target,
        startedAt,
      },
      { statePath: paths.state },
    );
    const backupDir = backupRunningTarget(pluginRoot, paths.backupRoot, now());
    logLine(paths.log, `upgrade ${currentVersion} -> ${target} tag=${tag} target=all backup=${backupDir || '-'}`);

    let result;
    try {
      result = spawnFn(NPX_BIN, ['--yes', `huaweicloud-devkit@${tag}`, 'update', '--target', 'all'], {
        encoding: 'utf8',
        timeout: 300000,
        windowsHide: true,
        shell: true,
        env: upgradeEnv(env),
      });
    } catch (error) {
      result = { status: null, error, stdout: '', stderr: '' };
    }
    const verified =
      result?.status === 0
        ? verifyInstalled(pluginRoot, target, readInstalled, backupDir)
        : { ok: false, installed: '' };
    if (verified.ok) {
      const succeeded = writeAutoUpgradeState(
        {
          lastResult: 'succeeded',
          trigger,
          fromVersion: currentVersion,
          targetVersion: target,
          installedVersion: verified.installed,
          requiresRestart: true,
          startedAt,
          finishedAt: new Date(now()).toISOString(),
        },
        { statePath: paths.state },
      );
      logLine(paths.log, `success installed=${verified.installed}`);
      return succeeded;
    }

    const reason = extractNpmFailureReason(result);
    const restored = restoreRunningTarget(pluginRoot, backupDir);
    const failed = writeAutoUpgradeState(
      {
        lastResult: 'failed',
        trigger,
        fromVersion: currentVersion,
        targetVersion: target,
        error: reason,
        restored,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
      },
      { statePath: paths.state },
    );
    logLine(paths.log, `fail ${reason} restored=${restored}`);
    return failed;
  } finally {
    releaseAutoUpgradeLock({ lockPath: paths.lock });
  }
}
