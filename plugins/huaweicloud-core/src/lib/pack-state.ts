import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { PackId } from './pack-types.ts';

// The pack-scoped state space and the single resolver for the devkit's
// config tree (~/.config/huaweicloud, relocatable whole-tree via
// HUAWEICLOUD_HOME).
//
// Ownership criterion, stated here so the next state file does not have to
// guess: the writer/reader set decides where state lives. approvals.json
// is the CLI approval face's store (plan_cli_command /
// run_approved_command mint and consume), credentials.json is the
// devkit-wide S1 store, and deps/ belongs to the dependency domain — all
// three stay at the config root. State with exactly one pack as writer
// and reader (the open-mcp gateway's policy file) lives under packs/<id>/,
// so ownership is derivable from the directory name and an uninstall can
// preserve user state without a manifest. Modules that still hand-roll
// the base (auth/credentials, dep/receipts, update-check, proxy-config,
// officeace-paths) migrate here when next touched; the guard below
// already resolves through this module, so guard and store cannot
// disagree about where the tree is.
//
// The same resolver backs the protected-tree guard the gateway face uses:
// anything the devkit or its operator considers consent infrastructure (the
// config tree, the operator-configured policy/audit files) must not be
// writable through gateway file tools. The guard resolves a candidate path
// the way a write through it lands — realpath of the deepest existing
// ancestor — so planted symlinks resolve through to their targets instead
// of defeating a lexical prefix check.
//
// Runtime import graph stays at node builtins plus a type-only edge (PackId)
// — the installer chain (dist/setup-cli.js, plain tsc output) must never
// pull zod, same contract as dependency-model.ts and dep-resolve.ts.

export function huaweiConfigBase(env: NodeJS.ProcessEnv = process.env): string {
  // resolve() absolutizes once, here, so every consumer — store writes and
  // the guard below — shares one anchor even for a relative
  // HUAWEICLOUD_HOME (a relative base previously made the store land at
  // the process cwd while the guard protected a tmpdir-anchored tree).
  return resolve(env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud');
}

export function packStateDir(packId: PackId, env: NodeJS.ProcessEnv = process.env): string {
  return join(huaweiConfigBase(env), 'packs', packId);
}

export interface PackStateLayout {
  dir: string;
  /** Logical file name → resolved path. */
  files: Record<string, string>;
}

// Idempotent provisioning, called at lazy-spawn time (a trimmed pack never
// calls it, so trimming keeps its zero-files-on-disk guarantee). Permissions
// are enforced on EVERY pass, not just first create: a pre-existing
// directory or file (earlier version, different umask, restored backup) may
// carry loose group/other bits, and the policy file this provisions is
// consent infrastructure.
export function ensurePackState(
  packId: PackId,
  fileNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PackStateLayout {
  const dir = packStateDir(packId, env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (error) {
    throw new Error(
      `cannot provision pack state directory "${dir}": ${error instanceof Error ? error.message : String(error)}. ` +
        'Fix the permissions, or point HUAWEICLOUD_HOME at a writable location.',
      { cause: error },
    );
  }
  const files: Record<string, string> = {};
  for (const name of fileNames) {
    const path = join(dir, name);
    try {
      try {
        // Exclusive-create, not exists-check + rename: 'wx' is atomic for
        // the zero-length write, cannot clobber a file a concurrent
        // provisioner (or a live gateway's permanent-scope grant) just
        // created, and leaves no predictable staging name behind.
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // Per-pass repair: a pre-existing file (earlier version, different
      // umask, restored backup) may carry loose group/other bits, and this
      // file is consent infrastructure.
      chmodSync(path, 0o600);
      files[name] = path;
    } catch (error) {
      throw new Error(
        `cannot provision pack state file "${path}": ${error instanceof Error ? error.message : String(error)}.`,
        { cause: error },
      );
    }
  }
  return { dir, files };
}

// Targets the guard refuses before any resolution. path.resolve() (and
// realpathSync on a not-yet-existing tail) collapse '..' against the
// accumulated STRING, but the kernel resolves '..' AFTER substituting each
// symlink component — with a planted symlink, 'link/../x' physically lands
// where resolve() never looked (probe-verified: the guard allowed while
// the write touched the protected tree). Legitimate scratch writes never
// need '..', so denying the segment outright costs nothing. Drive-relative
// win32 specifiers ('C:foo') are denied for the same reason: they anchor
// at the process's per-drive cwd, not the gateway child's cwd.
function isRefusedByGuard(target: string): boolean {
  if (process.platform === 'win32' && /^[a-zA-Z]:[^\\/]/.test(target)) return true;
  return target.split(/[\\/]/).includes('..');
}

// Resolve a path the way a WRITE through it lands: realpath the deepest
// existing ancestor, then re-join the not-yet-existing tail.
//
// Relative targets resolve against the gateway child's cwd, which the
// sidecar pins to tmpdir — never against this process's cwd. The write and
// the guard must resolve against the same base or they can diverge, and the
// divergence direction that matters (guard allows, write lands protected)
// is exactly the under-deny case.
//
// lstat (not existsSync) drives the walk: a dangling symlink is a present
// node even though existsSync follows it and reports false. A node that is
// present but fails realpath (dangling symlink) returns null — open-for-
// write through such a link can still CREATE the link target, so callers
// treat null as protected (fail closed).
function resolveForWrite(target: string): string | null {
  const absolute = resolve(tmpdir(), target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      tail.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  try {
    const real = realpathSync(current);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    return null;
  }
}

// The roots a gateway file write must never touch: the devkit config tree
// plus whatever policy/audit paths the operator configured (the LIVE paths,
// not what the devkit would have provisioned). Returns null when a root is
// present-but-unresolvable — callers deny everything in that case.
export function protectedTreeRoots(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const candidates: string[] = [huaweiConfigBase(env)];
  for (const key of ['HUAWEICLOUD_MCP_POLICY_FILE', 'HUAWEICLOUD_MCP_AUDIT_FILE'] as const) {
    const value = (env[key] ?? '').trim();
    if (value !== '') candidates.push(value);
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolveForWrite(candidate);
    if (resolved === null) return null;
    roots.push(resolved);
  }
  return roots;
}

// Containment check for the gateway face's write guard. Symlink semantics:
// a link outside the tree pointing at a protected file resolves through to
// the target and is DENIED; a link inside the tree pointing out resolves to
// the outside target and is ALLOWED (writing it does not touch protected
// state). Unresolvable paths (dangling links, unresolvable roots) are
// denied. Separator-terminated containment, so a sibling like
// packs/huaweicloud-open-mcp-extra never prefix-matches.
export function isInsideProtectedTree(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // Refused targets report as protected: the deny decision is identical,
  // and the batch-2 classifier can add message-level distinctions when it
  // consumes this result.
  if (isRefusedByGuard(target)) return true;
  const roots = protectedTreeRoots(env);
  if (roots === null) return true;
  const resolved = resolveForWrite(target);
  if (resolved === null) return true;
  return roots.some((root) => resolved === root || resolved.startsWith(root + sep));
}
