import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findHcloudBin } from './hcloud-probe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cross-process install lock so concurrent MCP processes / sessions don't all
// spawn `install-hcloud` at cold start. A stale lock (older than TTL) is
// reclaimed; a live lock makes this process yield to the in-flight installer.
const INSTALL_LOCK_TTL_MS = 15 * 60 * 1000;
const INSTALL_LOG_MAX_BYTES = 1024 * 1024;

export function kooCliInstallLogPath() {
  return join(homedir(), '.config', 'huaweicloud', 'logs', 'koocli-install.log');
}

export function kooCliInstallLockPath() {
  return join(homedir(), '.config', 'huaweicloud', '.koocli-install.lock');
}

// Atomically acquire the cross-process install lock (exclusive create). Reclaims
// a stale lock. Returns { acquired: true } or { acquired: false, reason }.
export function acquireInstallLock(lockPath = kooCliInstallLockPath()) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    let replace = false;
    try {
      const ts = Number(String(readFileSync(lockPath, 'utf8')).trim());
      if (Number.isFinite(ts) && Date.now() - ts > INSTALL_LOCK_TTL_MS) replace = true;
    } catch {}
    if (replace) {
      try {
        rmSync(lockPath, { force: true });
      } catch (error) {
        return { acquired: false, reason: `stale lock cleanup failed: ${error.message}` };
      }
    }
    writeFileSync(lockPath, String(Date.now()), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { acquired: true };
  } catch (error) {
    return {
      acquired: false,
      reason: error.code === 'EEXIST' ? 'another process is installing' : `lock error: ${error.message}`,
    };
  }
}

export function releaseInstallLock(lockPath = kooCliInstallLockPath()) {
  try {
    rmSync(lockPath, { force: true });
  } catch {}
}

// Open the install log, rotating (reset) once it exceeds INSTALL_LOG_MAX_BYTES
// and pinning 0600 so the path holds no sensitive mount-down rights for others.
export function openKooCliInstallLog(logPath = kooCliInstallLogPath()) {
  try {
    const st = existsSync(logPath) ? statSync(logPath) : null;
    if (st && st.size > INSTALL_LOG_MAX_BYTES) rmSync(logPath, { force: true });
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {}
  return createWriteStream(logPath, { flags: 'a', mode: 0o600 });
}

// Entry that dispatches `install-hcloud` into this file's own `main()` on import,
// exactly like bin/setup.cjs — but resolved as a sibling (src/setup-cli.mjs) so it
// works in copied install trees where the repo-top bin/ directory is absent.
export function resolvePreinstallCliEntry() {
  return join(__dirname, 'setup-cli.mjs');
}

let installStarted = false;

// Starts a one-shot background install of KooCLI when it is missing. Never throws
// and never blocks: on failure the child's output is captured in the log file and
// the session continues normally (the friendly not_found hint will point at the log).
//
// Trust boundary (P4): this runs `install-hcloud` unattended, i.e. it downloads and
// executes the official HTTPS installer without checksum verification. Only enable
// on trusted networks / over HTTPS; do not bypass with proxies you don't control.
export function maybePreinstallKooCli({ force = false } = {}) {
  if (installStarted && !force) return { launched: false, reason: 'already_launched' };
  if (process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL === '1') {
    return { launched: false, reason: 'disabled_by_env' };
  }
  if (findHcloudBin()) {
    return { launched: false, reason: 'already installed' };
  }

  const lock = acquireInstallLock();
  if (!lock.acquired) {
    return { launched: false, reason: lock.reason };
  }

  installStarted = true;
  const entryPath = resolvePreinstallCliEntry();
  if (!existsSync(entryPath)) {
    releaseInstallLock();
    console.error(`[preflight] install entry missing: ${entryPath}`);
    return { launched: false, reason: `install entry missing: ${entryPath}` };
  }
  const entry = pathToFileURL(entryPath).href;
  const log = openKooCliInstallLog();
  log.on('error', () => {});
  const release = () => {
    log.end();
    releaseInstallLock();
  };
  const child = spawn(process.execPath, [entry, 'install-hcloud'], {
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  child.on('error', (err) => {
    log.write(`[preflight] spawn failed: ${err.message}\n`);
    release();
  });
  child.on('close', () => release());
  return { launched: true, reason: 'background install started' };
}
