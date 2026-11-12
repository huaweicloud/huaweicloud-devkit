import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// The devkit's two directory roots. `configBase` is the historical
// ~/.config/huaweicloud tree (credentials, approvals, pack state, proxy and
// update state); `stateBase` is the same tree by default and moves to a
// writable agent-owned directory only when the config tree cannot be written.
//
// The split exists because some agent sandboxes ship a read-only home: the
// gateway's pack state, approval tokens, S1 writes and update state all need
// a writable directory, while the pre-provisioned credentials.json must stay
// readable at its original location. The installer/CLI and the MCP server
// resolve the same paths from the same filesystem, so no env plumbing is
// required for them to agree.
//
// Runtime import graph stays at node builtins — pack-state.ts (the stable
// resolver face) and the installer graph import this module.

const STATE_DIR_ENV = 'HUAWEICLOUD_STATE_DIR';
const AGENT_STATE_MARKERS = ['.codearts', '.codeartswork', '.codeartsdoer'] as const;

const stateBaseCache = new Map<string, string>();

export function huaweiConfigBase(env: NodeJS.ProcessEnv = process.env): string {
  // resolve() absolutizes once, here, so every consumer — store writes and
  // the protected-tree guard — shares one anchor even for a relative
  // HUAWEICLOUD_HOME (a relative base previously made the store land at
  // the process cwd while the guard protected a tmpdir-anchored tree).
  return resolve(env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud');
}

function agentHomeBase(env: NodeJS.ProcessEnv): string {
  return resolve(env.HUAWEICLOUD_HOME || homedir());
}

function nearestExisting(path: string): string | null {
  let current = resolve(path);
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

// A real create/remove probe, not access(W_OK): Windows ACLs and WSL drvfs
// can report a writable mode while mkdir still fails, and the gateway's first
// pack-state provisioning is exactly a mkdir under the config tree.
export function probeWritableDir(path: string): boolean {
  const anchor = nearestExisting(path);
  if (!anchor) return false;
  const probe = join(anchor, `.devkit-write-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(probe, { mode: 0o700 });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the probe directory is empty and 0700
    }
  }
}

// Agent-owned writable roots, checked in the same order the installer targets
// them: CodeArts Work's new layout, its legacy home, then CodeArts.
function codeArtsStateBase(env: NodeJS.ProcessEnv): string | null {
  const home = agentHomeBase(env);
  for (const marker of AGENT_STATE_MARKERS) {
    const root = join(home, marker);
    if (!existsSync(root) || !probeWritableDir(root)) continue;
    return join(root, 'devkit-state');
  }
  return null;
}

function explicitStateBase(env: NodeJS.ProcessEnv): string | null {
  const value = (env[STATE_DIR_ENV] ?? '').trim();
  if (value === '') return null;
  if (!isAbsolute(value)) {
    throw new Error(
      `${STATE_DIR_ENV} must be an absolute path (got "${value}"): the CLI and the MCP server resolve relative paths against different working directories.`,
    );
  }
  return resolve(value);
}

export function devkitStateBase(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = explicitStateBase(env);
  if (explicit) return explicit;
  const configBase = huaweiConfigBase(env);
  const cached = stateBaseCache.get(configBase);
  if (cached) return cached;
  const stateBase = probeWritableDir(configBase) ? configBase : (codeArtsStateBase(env) ?? configBase);
  stateBaseCache.set(configBase, stateBase);
  return stateBase;
}

// Doctor/installer display form: home-relative paths stay stable in the
// golden fixtures and read better to a human. Forward slashes keep the
// rendered form identical on Windows and POSIX (the goldens are committed
// once, not per platform).
export function displayStatePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = agentHomeBase(env).replace(/\\/g, '/');
  const normalized = path.replace(/\\/g, '/');
  if (normalized === home) return '~';
  return normalized.startsWith(home + '/') ? `~${normalized.slice(home.length)}` : normalized;
}

export function stateDirNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  const configBase = huaweiConfigBase(env);
  const stateBase = devkitStateBase(env);
  if (stateBase === configBase) return null;
  return `state directory ${displayStatePath(stateBase, env)} (${displayStatePath(configBase, env)} is not writable; set ${STATE_DIR_ENV} to pin it)`;
}

// Tests swap HUAWEICLOUD_HOME between cases; the cache is keyed by configBase,
// so this is only for a case that changes permissions under one home.
export function _resetStateDirCache(): void {
  stateBaseCache.clear();
}
