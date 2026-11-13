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
// Write discipline (interrogate round 1, finding 3): an append ADDS, it
// never rewrites. The write path appends to the raw parsed store, so
// entries the filtered reader cannot see (a hand-edited tier, an
// unmodeled field) and malformed-but-array entries survive verbatim; a
// store that exists but does not parse is quarantined (renamed aside with
// its bytes intact) before a fresh store starts, and when even the
// quarantine fails the append refuses to write at all — evidence is
// preserved at the cost of the append, never the other way around.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import type { ConsentEvent, ConsentEvidence } from './approval-types.ts';

function ledgerFilePath(): string {
  return join(devkitStateBase(), 'approval-consents.json');
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

// Best-effort append, same failure posture as the approvals store: an
// in-file failure degrades the audit trail but never fails the call the
// user just approved — with one carve-out: a store that exists but cannot
// be read is never overwritten. It is quarantined with its bytes intact
// first; if even the quarantine fails, the append is dropped so the
// original evidence survives.
export function appendConsentEvent(event: ConsentEvent): void {
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
      renameSync(path, `${path}.corrupt-${Date.now()}`);
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
    writeFileSync(tmp, JSON.stringify([...existing, event]), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // same degradation contract as writeApprovals in approval-tokens.ts
  }
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
  // confirmations in the later PRs).
  const original = latestGrantedFor(params.sessionId, params.tool, params.argsHash);
  const evidence = original ? original.evidence : (params.evidence ?? 'posture');
  appendConsentEvent({
    sessionId: params.sessionId,
    tool: params.tool,
    argsHash: params.argsHash,
    outcome: params.outcome,
    grantedAt: Date.now(),
    scope: 'once',
    evidence,
  });
}
