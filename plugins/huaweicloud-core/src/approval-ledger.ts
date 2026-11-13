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
// never be re-recorded as terminal-grade on retry — the inheritance is
// this module's one rewrite rule and the reason appendConsentEvent takes
// the optional inheritedEvidence.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import type { ConsentEvent, ConsentEvidence } from './approval-types.ts';

function ledgerFilePath(): string {
  return join(devkitStateBase(), 'approval-consents.json');
}

export function readConsentEvents(): ConsentEvent[] {
  try {
    const path = ledgerFilePath();
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const out: ConsentEvent[] = [];
    for (const entry of parsed) {
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
        // The store is untrusted input: a malformed entry reads as absent.
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
  } catch {
    return [];
  }
}

// Best-effort append, same failure posture as the approvals store: an
// in-file failure degrades the audit trail but never fails the call the
// user just approved.
export function appendConsentEvent(event: ConsentEvent): void {
  const events = readConsentEvents();
  events.push(event);
  try {
    const path = ledgerFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(events), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // same degradation contract as writeApprovals in approval-tokens.ts
  }
}

export function recordAskModeConsent(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  outcome: 'granted' | 'denied';
  evidence?: ConsentEvidence;
}): void {
  appendConsentEvent({
    sessionId: params.sessionId,
    tool: params.tool,
    argsHash: params.argsHash,
    outcome: params.outcome,
    grantedAt: Date.now(),
    scope: 'once',
    // An ask-mode arrival's evidence is the posture tier unless the caller
    // passes an inherited one (memo reuse in PR-3a).
    evidence: params.evidence ?? 'posture',
  });
}
