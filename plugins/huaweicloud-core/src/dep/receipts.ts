import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEPENDENCIES, type DependencyId } from '../lib/dependency-model.ts';
import type { ResolvedDependency } from '../lib/dep-resolve.ts';

// Install receipts: the uninstall half's ground truth for "this devkit placed
// that binary". A receipt exists only for a binary this devkit installed and
// verified, so `dep uninstall` can remove exactly what it placed and never a
// user-managed binary. The receipt directory rides the repo's shared home
// convention (HUAWEICLOUD_HOME || homedir() → ~/.config/huaweicloud/), the
// same rule as mcp-config-backup.ts, update-check.ts, and officeace-paths.ts.
//
// This module is also the leaf home of the dep subsystem's shared contracts
// (DepUninstallResult, ResolvedUninstallContext,
// ManagedChildInstallResult) and the best-effort receipt recorder: the
// per-dependency installers (installers/hcloud.ts, installers/gateway.ts)
// and the decision core (provision.ts) all consume them, so they must sit
// below both.
//
// Receipts are single-phase on purpose: the receipt is written ONLY after the
// installing run verified the binary landed. A pending/two-phase scheme (mark
// intent, install, confirm) was reviewed and rejected: a receipt that
// survives a crash cannot distinguish devkit's half-install from the user's
// own install, and devkit must never claim what it did not place. Crash
// recovery needs no reconciliation — a crashed install left no receipt, so a
// later uninstall simply refuses and points at the documented escape hatch.
//
// Receipt mutations and the uninstall decision serialize on a lock in the
// receipt dir: a DIRECTORY claimed with mkdir (atomic, EEXIST means held)
// carrying the holder's pid. A lock is taken over only when its pid is
// verifiably dead (or wedged past a window exceeding the longest critical
// section), so a live holder's lock is never removed and no rename ever
// opens a free-path window — see the lock section below for the full design
// and the residual. Concurrent install+uninstall converges: worst case the
// install re-places the binary after an uninstall completed.
//
// Every function takes the receipt dir as an optional parameter (defaulting
// to the real convention) so tests run against a temp directory — the same
// injectability pattern as mcp-config-backup.ts's base parameter.

export interface DepReceipt {
  binary: DependencyId;
  provisioner: 'devkit';
  /** Gateway installs record the tier that placed them (tier-aware uninstall). */
  tier?: 'uv' | 'pipx' | 'pip3';
  /** The path devkit placed (hcloud); gateway installs record the tier instead. */
  path?: string;
  installedAt: string;
}

export function receiptDir(base: string = process.env.HUAWEICLOUD_HOME || homedir()): string {
  return join(base, '.config', 'huaweicloud', 'deps');
}

function receiptPath(id: DependencyId, dir: string): string {
  return join(dir, `${id}.json`);
}

// A record that does not attribute the binary to this devkit (wrong id,
// foreign provisioner, missing timestamp) reads as absent: uninstall then
// refuses rather than deleting something it cannot claim.
export function readReceipt(id: DependencyId, dir: string = receiptDir()): DepReceipt | null {
  const file = receiptPath(id, dir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.binary !== id || record.provisioner !== 'devkit' || typeof record.installedAt !== 'string') {
      return null;
    }
    const receipt: DepReceipt = { binary: id, provisioner: 'devkit', installedAt: record.installedAt };
    if (record.tier === 'uv' || record.tier === 'pipx' || record.tier === 'pip3') receipt.tier = record.tier;
    if (typeof record.path === 'string' && record.path.length > 0) receipt.path = record.path;
    return receipt;
  } catch {
    return null;
  }
}

// Atomic write (temp file + rename, the update-check.ts skip-state pattern):
// a reader never observes a half-written receipt, and a crash mid-write
// leaves only a stray .tmp, never a corrupt <id>.json.
export function writeReceipt(receipt: DepReceipt, dir: string = receiptDir()): void {
  if (DEPENDENCIES[receipt.binary]?.kind === 'sandbox-resident') {
    throw new Error(`${receipt.binary} is sandbox-resident; the host never manages it, so it cannot carry a receipt`);
  }
  withDepLock(() => {
    mkdirSync(dir, { recursive: true });
    const file = receiptPath(receipt.binary, dir);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }, dir);
}

export function removeReceipt(id: DependencyId, dir: string = receiptDir()): void {
  withDepLock(() => {
    rmSync(receiptPath(id, dir), { force: true });
  }, dir);
}

const RECEIPTS_WARN = '  \x1b[33m[WARN]\x1b[0m';

// Receipt writes are best-effort bookkeeping after a verifiably successful
// install: a failed write must not fail the install (the binary is real, the
// escape hatch still exists), and an already-present binary never reaches
// this function — the provisioning loop skips before the installer runs, so
// devkit only ever claims a binary this run placed.
export function recordInstallReceipt(receipt: DepReceipt): void {
  try {
    writeReceipt(receipt);
  } catch (error) {
    console.log(
      `${RECEIPTS_WARN} could not write the install receipt for ${receipt.binary}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The result every receipt-gated uninstall returns: ok=false renders via
// console.error with exit code 1 in the dep CLI.
export interface DepUninstallResult {
  /** False renders via console.error with exit code 1 in the dep CLI. */
  ok: boolean;
  message: string;
  detail?: string[];
}

// The seams an installer's uninstall body needs, normalized to required
// fields by the decision core (provision.ts's placedUninstall) before the
// per-dependency uninstaller runs: the env to resolve under, the shared
// dependency-resolution chain, and the command runner for tier withdrawals
// and sudo escalation. Injected overrides from DepUninstallOptions keep
// their precedence; the defaults are applied exactly once, at the gate.
export interface ResolvedUninstallContext {
  env: NodeJS.ProcessEnv;
  resolveDependency: (_id: DependencyId, _env: NodeJS.ProcessEnv) => ResolvedDependency | null;
  runCommand: (_command: string, _args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
}

// The outcome a managed-child install reports to the policy loop: ok plus
// the display detail for the "installed via <tier>" line. The gateway
// installer refines tier to its own tool union (GatewayInstallTier); the
// shared shape keeps the decision core and the installer interfaces free
// of gateway vocabulary.
export interface ManagedChildInstallResult {
  ok: boolean;
  tier: string | null;
}

// ---------------------------------------------------------------------------
// The lock. Sync critical sections only: the uninstall decision and the
// receipt mutations are plain fs operations, so the guard is a plain sync
// function. Same-process re-entry (an uninstall body calling removeReceipt)
// recurses instead of deadlocking on its own lock.
//
// DESIGN: the lock is a DIRECTORY claimed with mkdir (O_EXCL semantics —
// EEXIST means someone holds it), carrying a pid file written by the holder
// AFTER the claim, into the holder's own directory, where no other process
// can observe a half-written state as stealable. A path FILE plus rename
// takeover was tried three times and kept failing the two-contender
// mutual-exclusion test; the directory design narrows the windows but does
// NOT remove the race class structurally — round-11 live-reproduced a
// double hold through the takeover path (two contenders both pass the
// re-read against the same dead lock; the slower one's mutation lands
// after the faster one's fresh claim and steals it). Every mutation of the
// lock path is therefore a SELF-VALIDATING rename:
//
//   - acquiring = mkdir; the only writer of the pid file is the holder, and
//     it writes into its OWN directory (no cross-process half-state);
//   - a lock is taken over ONLY when its pid file names a process that is
//     verifiably dead (a dead owner can never be inside its section or
//     release later) or when the takeover window expired on a wedged holder
//     (documented residual: a >90s "live" holder is assumed wedged; the
//     critical sections cap at ~60s);
//   - the takeover renames the lock to a per-process stash and re-reads
//     the stash's pid: only a stash still naming the SAME judged-dead
//     holder honors the win; anything else means the rename stole a live
//     claim and the stash is restored;
//   - an EMPTY lock directory (holder between mkdir and its pid write —
//     microseconds) is unknown, never stealable: waiters poll past it;
//   - release is the same self-validating rename: the lock moves to a
//     stash whose pid must still name THIS process before removal, so a
//     wedged holder releasing after a takeover restores the taker's claim
//     instead of deleting it.
//
// Residual: pid reuse could make a dead holder's pid look alive — that only
// DELAYS a takeover past the window (bounded, converges). A crash between
// a winning rename and its verification leaves a reclaimable stash; the
// acquire-time sweep removes those.
// ---------------------------------------------------------------------------

const LOCK_DIR_NAME = 'lock';
const LOCK_PID_FILE = 'pid';
const LOCK_POLL_MS = 50;
// A live holder doing real work is waited out; a holder wedged past this
// window is taken over anyway — the guard must never block forever. The
// window must exceed the longest critical section (the tier uninstall's
// 60s spawnSync) plus resolution margin, or a legitimate holder still
// inside its section gets its lock taken over mid-flight.
const LOCK_TAKEOVER_MS = 90_000;

const lockDepth = new Map<string, number>();
const heldDirs = new Set<string>();
let exitCleanupInstalled = false;

function lockDirPath(dir: string): string {
  return join(dir, LOCK_DIR_NAME);
}

function isPidAlive(pid: number): boolean {
  // kill(pid, 0) succeeds against an unreaped zombie: the holder exited but
  // its parent never waited, so the pid stays allocated and the kernel still
  // answers the signal probe. A crashed holder's lock must not be treated as
  // live for the whole takeover window, so on Linux /proc/<pid>/stat is the
  // truth (state Z means the process can never run again) and kill(pid, 0) is
  // only the fallback for other platforms and read failures.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm is parenthesized and may itself contain ')' or spaces, so the
      // state is the first field after the LAST closing paren.
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      return state !== 'Z';
    } catch {
      // Unreadable /proc (reaped pid, or an exotic mount): fall through.
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user. ESRCH: dead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The holder's pid, read from the pid file inside its lock directory. null
// means the directory is empty (the holder is between mkdir and its pid
// write) or unreadable — unknown, which callers treat as "keep waiting",
// never as stealable.
function readHolderPid(dir: string): number | null {
  return readPidAt(join(lockDirPath(dir), LOCK_PID_FILE));
}

// The pid inside a takeover stash — same layout as a live lock directory,
// at an arbitrary path. Round-11: the arbitration validates the stash's
// contents AFTER winning the rename, so a rename that stole a live claim
// is detected and restored instead of honored.
function readStashHolderPid(stashDir: string): number | null {
  return readPidAt(join(stashDir, LOCK_PID_FILE));
}

function readPidAt(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Crash-orphaned takeover/release stashes: a process that died between
// its winning rename and the stash rm left `${lock}.*.takeover` (or
// `.release`) behind. The lock machinery never looks at them again, so
// they would accumulate forever (round-11). Any stale stash is
// unclaimed by construction — a live winner renames its OWN stash away —
// so a best-effort sweep at acquire time is safe.
function sweepStaleStashes(dir: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(`${LOCK_DIR_NAME}.`) && (entry.endsWith('.takeover') || entry.endsWith('.release'))) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // unreadable or absent receipt dir: the claim below will recreate it
  }
}

function acquireLock(dir: string, takeoverMs: number = LOCK_TAKEOVER_MS): void {
  mkdirSync(dir, { recursive: true });
  sweepStaleStashes(dir);
  const lock = lockDirPath(dir);
  const deadline = Date.now() + takeoverMs;
  for (;;) {
    try {
      mkdirSync(lock);
      // Written into our OWN directory after the atomic claim: no other
      // process ever sees this file half-written, and no other process ever
      // writes it. The mkdir alone is the claim; the pid file is the
      // attribution takeovers judge on.
      writeFileSync(join(lock, LOCK_PID_FILE), `${process.pid}\n`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readHolderPid(dir);
    // An empty directory (holder mid-create, microseconds) is unknown and
    // never stealable — wait it out; a crashed creator's empty dir is
    // reclaimed only past the takeover window below.
    if (holder !== null && isPidAlive(holder) && Date.now() < deadline) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    if (holder === null && Date.now() < deadline) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    // Verified removal — the judgment above may be STALE: another taker can
    // have replaced the lock between our read and this point, and removing
    // its fresh claim would let two processes hold at once. Re-read
    // immediately before removing, and only remove when the pid still names
    // the SAME verifiably-dead holder (or the directory is still empty past
    // the window): while the dead holder's directory stands, no new claim
    // can exist — claims need the path absent — so a re-read that still
    // matches is safe to act on. A changed pid means the lock is someone
    // else's now: keep waiting.
    if (readHolderPid(dir) !== holder) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    // The removal is a SELF-VALIDATING arbitration (round-11: the bare
    // rename did not close the race — a loser whose rename lands after
    // the winner's mkdir steals the winner's FRESH live lock; both hold.
    // Live-reproduced with a stalled contender). renameSync moves the
    // lock to a per-process stash, then the stash's pid is re-read: only
    // a stash that still names the SAME judged-dead holder (or the
    // empty-past-deadline case) honors the win. A stash naming anyone
    // else means the rename stole a live claim — restore it and wait.
    const uniqueStash = `${lock}.${process.pid}.${Date.now()}.takeover`;
    try {
      renameSync(lock, uniqueStash);
    } catch {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    const stashHolder = readStashHolderPid(uniqueStash);
    const stashStillOurs = holder === null ? stashHolder === null : stashHolder === holder;
    if (!stashStillOurs) {
      // The rename took a live claim: put it back and wait.
      try {
        renameSync(uniqueStash, lock);
      } catch {
        // The lock path is occupied again — the stash is orphaned; the
        // entry sweep below reclaims it.
      }
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    rmSync(uniqueStash, { recursive: true, force: true });
  }
}

// Remove the lock only while its pid file still names this process, and
// do it as a SELF-VALIDATING rename (round-11): the read-then-rmSync
// shape had the same steal window the acquisition path had — a wedged
// holder releasing just after a takeover could delete the NEW holder's
// lock between its pid read and its rm. Renaming to a per-process stash
// and verifying the stash's pid still names THIS process makes the
// release fail-safe: a stash naming anyone else means the lock was taken
// over, and the stash is restored.
function releaseLock(dir: string): void {
  const lock = lockDirPath(dir);
  const stash = `${lock}.${process.pid}.${Date.now()}.release`;
  try {
    renameSync(lock, stash);
  } catch {
    return; // already gone or taken over: nothing to release
  }
  if (readStashHolderPid(stash) === process.pid) {
    rmSync(stash, { recursive: true, force: true });
  } else {
    // The lock was taken over between our rename and this read: restore
    // the taker's claim. A failed restore leaves a reclaimable stash.
    try {
      renameSync(stash, lock);
    } catch {
      // the sweep in acquireLock reclaims the orphan
    }
  }
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // finally blocks do not run through process.exit(); this is the safety net.
  process.on('exit', () => {
    for (const dir of heldDirs) releaseLock(dir);
  });
}

export function withDepLock<T>(fn: () => T, dir: string = receiptDir(), takeoverMs: number = LOCK_TAKEOVER_MS): T {
  const depth = lockDepth.get(dir) ?? 0;
  if (depth > 0) {
    lockDepth.set(dir, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(dir, depth - 1);
    }
  }
  acquireLock(dir, takeoverMs);
  installExitCleanup();
  heldDirs.add(dir);
  lockDepth.set(dir, 1);
  try {
    return fn();
  } finally {
    lockDepth.set(dir, 0);
    releaseLock(dir);
    heldDirs.delete(dir);
  }
}
