import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findHcloudBin } from './hcloud-probe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function kooCliInstallLogPath() {
  return join(homedir(), '.config', 'huaweicloud', 'logs', 'koocli-install.log');
}

// Repo-top executable that dispatches `install-hcloud` into src/setup-cli.mjs.
// preflight lives at plugins/huaweicloud-core/src/, so the repo-top-level bin
// is three levels up.
export function resolvePreinstallCliEntry() {
  return join(__dirname, '..', '..', '..', 'bin', 'setup.cjs');
}

let installStarted = false;

// Starts a one-shot background install of KooCLI when it is missing. Never throws
// and never blocks: on failure the child's output is captured in the log file and
// the session continues normally (the friendly not_found hint will point at the log).
export function maybePreinstallKooCli({ force = false } = {}) {
  if (installStarted && !force) return { launched: false, reason: 'already_launched' };
  if (process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL === '1') {
    return { launched: false, reason: 'disabled_by_env' };
  }
  if (findHcloudBin()) {
    return { launched: false, reason: 'already installed' };
  }

  installStarted = true;
  const entryPath = resolvePreinstallCliEntry();
  if (!existsSync(entryPath)) {
    console.error(`[preflight] install entry missing: ${entryPath}`);
    return { launched: false, reason: `install entry missing: ${entryPath}` };
  }
  const entry = pathToFileURL(entryPath).href;
  const logDir = dirname(kooCliInstallLogPath());
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {}
  const log = createWriteStream(kooCliInstallLogPath(), { flags: 'a' });
  const child = spawn(process.execPath, [entry, 'install-hcloud'], {
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  child.on('error', (err) => {
    log.write(`[preflight] spawn failed: ${err.message}\n`);
    log.end();
  });
  child.on('close', () => log.end());
  return { launched: true, reason: 'background install started' };
}
