// Ask-mode consent ledger: one JSON event per completed ask-mode approval
// arrival, appended to the devkit state tree. Token mode records nothing —
// its evidence is the custody-HMAC grant inside approvals.json (single use,
// tombstone, five-minute TTL, all unchanged).
//
// The evidence tier is written from day one: 'posture' for ask-mode
// arrivals (the harness client's prompt is the confirmation the mode
// trusts), 'terminal' for approve-CLI confirmations the plan face reports,
// 'elicitation' from PR-4. A memo-reuse event (PR-3a) inherits the
// ORIGINAL event's tier and never upgrades it, so a posture-grade yes can
// never be re-recorded as terminal-grade on retry — recordAskModeConsent
// ENFORCES the inheritance by resolving the tier itself from the prior
// event on the same consent key (sessionId + tool + argsHash): the
// caller's evidence parameter is consulted only when no prior event
// exists.
//
// Write discipline (interrogate rounds 1-2): an append ADDS, it never
// rewrites, and every committed append SURVIVES. The write path appends
// to the raw parsed store, so entries the filtered reader cannot see (a
// hand-edited tier, an unmodeled field) and malformed-but-array entries
// survive verbatim; the whole read-modify-write runs inside the repo's
// per-store file lock (withDepLock, the dep receipts' mkdir-claim lock
// with takeover and exit cleanup), so concurrent writers — separate MCP
// server processes on one machine — serialize instead of erasing each
// other's committed events. A store that exists but does not parse is
// quarantined (renamed aside with its bytes intact, under a pid+counter
// name so same-millisecond quarantines cannot overwrite each other)
// before a fresh store starts, and when even the quarantine fails the
// append refuses to write at all — evidence is preserved at the cost of
// the append, never the other way around.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import { withDepLock } from './dep/receipts.ts';
import type { ConsentEvent, ConsentEvidence } from './approval-types.ts';

function ledgerFilePath(): string {
  return join(devkitStateBase(), 'approval-consents.json');
}

// The lock directory beside the store: withDepLock claims <dir>/lock with
// mkdir (O_EXCL semantics), so every process appending to this store
// serializes on one path. The lock lives in the state tree with the store
// it guards — same ownership, same relocation via HUAWEICLOUD_HOME.
function ledgerLockDir(): string {
  return join(devkitStateBase(), 'approval-consents-lock');
}

// The takeover window, sized to THIS critical section (interrogate rounds
// 3-4). Round 3 set 1s on the claim that the section is a millisecond RMW;
// round 4 measured the claim false — the store is append-only forever, so
// the section is O(store) plus the home directory's latency, and a 1s
// window stole a LIVE productive writer mid-section, silently erasing a
// committed event (600k-event store: 1.9-2.9s sections; a 44KB store on a
// 1200ms-latency fs: the same). No constant can win that race; liveness
// must be the criterion. The window now covers only what cannot heartbeat:
// an empty stale lock dir (a crash between mkdir and the pid write) is
// reclaimed at 1s, a dead holder immediately, while a LIVE holder claims a
// worker-thread heartbeat (LEDGER_HEARTBEAT_MS) that refreshes the claim's
// mtime for the duration of the section — a beating holder never goes
// stale, however long its section runs, and is waited out instead of
// stolen. Only a live holder whose heartbeat stops (a genuinely wedged
// process) falls back to the window.
const LEDGER_LOCK_TAKEOVER_MS = 1_000;
const LEDGER_HEARTBEAT_MS = 200;

// The filtered view consumers read: every entry that parses to the
// ConsentEvent shape. Malformed entries read as absent — read tolerance is
// fine; the WRITE path never uses this view (it preserves raw entries).
export function readConsentEvents(): ConsentEvent[] {
  const raw = readRawConsents();
  if (raw === undefined) return [];
  const out: ConsentEvent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.sessionId !== 'string' ||
      typeof record.tool !== 'string' ||
      typeof record.argsHash !== 'string' ||
      typeof record.grantedAt !== 'number' ||
      (record.outcome !== 'granted' && record.outcome !== 'denied') ||
      (record.scope !== 'once' && record.scope !== 'session') ||
      (record.evidence !== 'terminal' && record.evidence !== 'elicitation' && record.evidence !== 'posture')
    ) {
      continue;
    }
    out.push({
      sessionId: record.sessionId,
      tool: record.tool,
      argsHash: record.argsHash,
      outcome: record.outcome,
      grantedAt: record.grantedAt,
      scope: record.scope,
      evidence: record.evidence,
    });
  }
  return out;
}

// The store as-is: the parsed array when the file holds one, undefined
// when the file is absent. A file that exists but does not parse to an
// array is the caller's corrupt case — this reader takes no position on
// it beyond "not a usable store".
function readRawConsents(): unknown[] | undefined {
  try {
    const path = ledgerFilePath();
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Quarantine sidecar naming (interrogate rounds 2-3): pid plus a random
// UUID suffix — never a per-process counter, which resets and lets a
// pid-reincarnated process rename onto the dead incarnation's sidecar and
// silently replace the preserved bytes. With a UUID the name is unique per
// quarantine by construction; the pre-existing sidecar always wins its
// bytes.
function quarantineSidecarName(path: string): string {
  return `${path}.corrupt-${process.pid}-${randomUUID()}`;
}

// The locked append core: read the raw store, quarantine an unreadable
// one, write existing-plus-events. Runs ONLY inside a withDepLock hold —
// the public functions acquire it (and re-entrancy makes a nested call
// from inside another hold safe, so the tier resolution in
// recordAskModeConsent and the append share ONE serialized section). The
// WHOLE body is best-effort (interrogate round 4): every internal failure
// — the store-path resolution included (a relative HUAWEICLOUD_STATE_DIR
// makes devkitStateBase throw INSIDE the lock), any fs error, the
// quarantine rename — degrades internally, so lockedAppend CANNOT throw.
// That invariant, now true, is what lets withLedgerLock treat any
// exception from withDepLock as an acquisition failure, and lets the
// ledger honor its contract: an internal failure degrades the audit
// trail, never the approved call (trunk recorded no consent at all).
function lockedAppend(events: ConsentEvent[]): void {
  try {
    const path = ledgerFilePath();
    let existing: unknown[];
    const raw = readRawConsents();
    if (raw !== undefined) {
      existing = raw;
    } else if (existsSync(path)) {
      // Present but unreadable (or not an array): preserve-then-write. The
      // rename is atomic on POSIX, so the bytes land in the quarantine file
      // before the new store is ever written.
      try {
        renameSync(path, quarantineSidecarName(path));
      } catch {
        return; // cannot preserve → refuse to overwrite
      }
      existing = [];
    } else {
      existing = [];
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...existing, ...events]), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // same degradation contract as writeApprovals in approval-tokens.ts
    }
  } catch {
    // never fail the approved call the user just approved
  }
}

// Acquire the ledger lock for one append body. The degradation covers the
// WHOLE acquisition attempt, not just the lock root's creation (interrogate
// round 3, finding 4): once the root exists — the first append creates it
// and it is never removed — a read-only tree makes the CLAIM mkdir's
// EACCES the caller's problem, and an approved call failed. A tree that
// cannot host the lock cannot host racing writers, warm or fresh, so ANY
// acquisition failure (root mkdir, stale-stash sweep, claim mkdir, poll
// error — and the lock-dir path resolution itself, which a relative
// HUAWEICLOUD_STATE_DIR makes throw) proceeds UNLOCKED instead of
// surfacing. A body failure is a different fact: the bodyRan flag makes
// the catch a no-op once the body started, so the append body never runs
// twice and a body-internal throw (impossible by lockedAppend's
// hardening, but held defensively) degrades to a no-op rather than a
// second attempt. The heartbeat rides on the same acquisition, keeping a
// live section claim-fresh for its whole duration (interrogate round 4).
function withLedgerLock(fn: () => void): void {
  let bodyRan = false;
  try {
    withDepLock(
      () => {
        bodyRan = true;
        fn();
      },
      ledgerLockDir(),
      LEDGER_LOCK_TAKEOVER_MS,
      LEDGER_HEARTBEAT_MS,
    );
  } catch {
    if (!bodyRan) fn();
  }
}

// Best-effort append, same failure posture as the approvals store: an
// in-file failure degrades the audit trail but never fails the call the
// user just approved — with one carve-out: a store that exists but cannot
// be read is never overwritten (it is quarantined with its bytes intact
// first, and the append is dropped when even that fails). The whole
// read-modify-write runs inside the per-store lock, so concurrent
// appenders — separate MCP server processes on one machine — serialize:
// each reads the store the previous one wrote, instead of both writing
// from the same snapshot and erasing committed events.
export function appendConsentEvent(event: ConsentEvent): void {
  withLedgerLock(() => lockedAppend([event]));
}

// The most recent GRANTED event on this consent key: the original a
// memo-reuse inherits from. A denied arrival is not a consent — a retry
// after one is a fresh ask, not a reuse.
function latestGrantedFor(sessionId: string, tool: string, argsHash: string): ConsentEvent | undefined {
  const events = readConsentEvents();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      event.sessionId === sessionId &&
      event.tool === tool &&
      event.argsHash === argsHash &&
      event.outcome === 'granted'
    ) {
      return event;
    }
  }
  return undefined;
}

export function recordAskModeConsent(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  outcome: 'granted' | 'denied';
  evidence?: ConsentEvidence;
}): void {
  // Tier resolution is the ledger's rule, not the caller's: a reuse
  // inherits the original event's tier verbatim — never upgraded (posture
  // stays posture when the caller asks for terminal) and never downgraded
  // (terminal stays terminal) — and only a FRESH key takes the caller's
  // evidence (posture for ask arrivals, terminal for approve-CLI
  // confirmations in the later PRs). The resolution and the append share
  // ONE lock hold (appendConsentEvent re-enters it), so two racing
  // arrivals on the same key both resolve against the store the other
  // left, not a stale snapshot. A resolution failure (an unreadable store
  // the hardened read already degrades to empty, a state-dir validation
  // throw) degrades to the caller's tier so the append still lands — the
  // same best-effort posture as the append itself (interrogate round 4).
  withLedgerLock(() => {
    let evidence = params.evidence ?? 'posture';
    try {
      const original = latestGrantedFor(params.sessionId, params.tool, params.argsHash);
      if (original) evidence = original.evidence;
    } catch {
      // degrade to the caller's tier: the append is the fact that matters
    }
    appendConsentEvent({
      sessionId: params.sessionId,
      tool: params.tool,
      argsHash: params.argsHash,
      outcome: params.outcome,
      grantedAt: Date.now(),
      scope: 'once',
      evidence,
    });
  });
}
