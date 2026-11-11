import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { asText } from './lib/as-text.ts';
import { pkgVersion, sleepSync } from './payload-utils.ts';

// The runtime-deps installer (the install-payload.ts internals split): the
// npm spawn that provisions undici into a per-agent plugins dir, with the
// file-lock retry ladder. spawnErrorCode stays family-internal here — the
// face never re-exports it.

function spawnErrorCode(res: SpawnSyncReturns<unknown>): string | undefined {
  const error = res.error;
  if (!error || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

export function installRuntimeDeps(pluginsDir: string): void {
  const pkgJson = {
    name: 'huaweicloud-devkit',
    version: pkgVersion,
    type: 'module',
    dependencies: { undici: '^8.10.0' },
  };
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  const spawnOpts: SpawnSyncOptions = {
    cwd: pluginsDir,
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 120000,
  };
  // A string command, never an args array: args + shell:true is DEP0190 on
  // Node 24 (the shell concatenates args unescaped), and the warning lands
  // on the CLI's own stderr mid-install — deferred by emitWarning, it even
  // surfaced glued to the provisioning prompt (2026-11-10 report #2). The
  // words are static, so the shell concatenation is injection-safe by
  // construction, and shell:true stays load-bearing: it routes npm.cmd on
  // Windows (the #643 EINVAL doctrine).
  const installCommand = 'npm install --omit=dev --no-audit --no-fund';
  let r = spawnSync(installCommand, spawnOpts);
  const isRetryable = (res: SpawnSyncReturns<unknown>): boolean => {
    if (res.status === 0) return false;
    const stderr = asText(res.stderr || '');
    return spawnErrorCode(res) === 'EPERM' || spawnErrorCode(res) === 'EBUSY' || /EPERM|EBUSY/.test(stderr);
  };
  if (r.status !== 0 && isRetryable(r)) {
    console.log(`  \x1b[33m[WARN]\x1b[0m npm install hit file-lock error, retrying in 2s...`);
    sleepSync(2000);
    r = spawnSync(installCommand, spawnOpts);
  }
  if (r.status !== 0 && !isRetryable(r)) {
    console.log(`  \x1b[33m[RETRY]\x1b[0m npm install failed (exit ${r.status}), retrying in 3s...`);
    sleepSync(3000);
    r = spawnSync(installCommand, spawnOpts);
  }
  const undiciDir = join(pluginsDir, 'node_modules', 'undici');
  if (r.status === 0 && existsSync(undiciDir)) {
    console.log(`  Runtime deps installed -> ${join(pluginsDir, 'node_modules')}`);
  } else {
    const errCode = spawnErrorCode(r);
    const err = (r.stderr || '').toString().trim().split(/\r?\n/).slice(-2).join(' ');
    const hint = errCode === 'ENOENT' ? ' (npm not found — ensure Node.js/npm is in PATH)' : '';
    const msg = `npm install failed in ${pluginsDir}${err ? `: ${err}` : ''}${hint}`;
    console.log(`  \x1b[31m[ERROR]\x1b[0m ${msg}`);
    console.log('  Manual fix: cd %s && npm install', pluginsDir);
    if (!existsSync(undiciDir)) {
      console.log(`  \x1b[31m[ERROR]\x1b[0m undici is NOT installed. MCP server will fail to start.`);
      console.log(`  Run manually: cd "${pluginsDir}" && npm install undici@^8.10.0`);
    }
    throw new Error(msg);
  }
}
