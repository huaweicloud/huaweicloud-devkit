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

// Quarantine sidecar naming: pid plus a process-lifetime counter, so two
// quarantines in the same millisecond of the same process (and any
// same-name collision across processes) never overwrite each other — the
// first quarantine always keeps the original bytes (interrogate round 2,
// finding 4).
let quarantineCounter = 0;

// The locked append core: read the raw store, quarantine an unreadable
// one, write existing-plus-events. Runs ONLY inside a withDepLock hold —
// the public functions acquire it (and re-entrancy makes a nested call
// from inside another hold safe, so the tier resolution in
// recordAskModeConsent and the append share ONE serialized section).
function lockedAppend(events: ConsentEvent[]): void {
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
      renameSync(path, `${path}.corrupt-${process.pid}-${quarantineCounter++}`);
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
}

// Acquire the ledger lock for one append body — with the same degradation
// posture as the store writes: a state tree that cannot host the lock
// directory cannot host racing writers either, so the append proceeds
// unlocked instead of failing the call the user just approved. Any other
// lock failure propagates: with a writable tree it is a bug to surface,
// not a degradation to hide.
function withLedgerLock(fn: () => void): void {
  try {
    mkdirSync(ledgerLockDir(), { recursive: true });
  } catch {
    fn();
    return;
  }
  withDepLock(fn, ledgerLockDir());
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
  // left, not a stale snapshot.
  withLedgerLock(() => {
    const original = latestGrantedFor(params.sessionId, params.tool, params.argsHash);
    appendConsentEvent({
      sessionId: params.sessionId,
      tool: params.tool,
      argsHash: params.argsHash,
      outcome: params.outcome,
      grantedAt: Date.now(),
      scope: 'once',
      evidence: original ? original.evidence : (params.evidence ?? 'posture'),
    });
  });
}
