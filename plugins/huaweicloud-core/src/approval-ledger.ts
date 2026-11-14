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
// Write discipline (interrogate rounds 1-6): an append ADDS, it never
// rewrites, and every committed append SURVIVES. The locked write path
// appends to the raw parsed store, so entries the filtered reader cannot
// see (a hand-edited tier, an unmodeled field) and malformed-but-array
// entries survive verbatim, and the whole read-modify-write runs inside
// the repo's per-store file lock (withDepLock, the dep receipts'
// mkdir-claim lock with takeover and exit cleanup), so concurrent locked
// writers serialize. A store that exists but does not parse is quarantined
// (renamed aside with its bytes intact, under a pid+UUID name) before a
// fresh store starts, and when even the quarantine fails the append refuses
// to write at all — evidence is preserved at the cost of the append, never
// the other way around.
//
// The DEGRADED path (round 6): past the wait cap — a wedged-but-beating
// holder, a section over the cap on a huge or slow store — the waiter
// degrades rather than stall an approved call, but the degraded append is
// NOT a second unlocked read-modify-write: that shape re-opened the exact
// erasure the lock exists to prevent (a degraded writer's snapshot loses
// the locked holder's in-flight event; measured rc=0 on both sides with
// the committed event gone). The degraded append is strictly ADDITIVE: it
// appends one JSON line per event to a spool file beside the store (the
// O_APPEND whole-file protocol — no read, no rewrite, nothing to erase),
// the reader merges spool lines into the filtered view, and the next
// LOCKED append compacts the spool into the main store under the lock.
// The degradation may cost latency, never evidence.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import { withDepLock } from './dep/receipts.ts';
import type { ConsentEvent, ConsentEvidence } from './approval-types.ts';

function ledgerFilePath(): string {
  return join(devkitStateBase(), 'approval-consents.json');
}

// The spool: degraded appends land here, one JSON event per line, append
// mode only. Compacted into the main store by the next locked append.
function ledgerSpoolPath(): string {
  return `${ledgerFilePath()}.spool.jsonl`;
}

// The lock directory beside the store: withDepLock claims <dir>/lock with
// mkdir (O_EXCL semantics), so every process appending to this store
// serializes on one path. The lock lives in the state tree with the store
// it guards — same ownership, same relocation via HUAWEICLOUD_HOME.
function ledgerLockDir(): string {
  return join(devkitStateBase(), 'approval-consents-lock');
}

// The takeover window, sized to THIS critical section (interrogate rounds
// 3-5). Round 3 set 1s on the claim that the section is a millisecond RMW;
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
// stolen.
//
// Round 5 closed the hole that left: a wedged MAIN thread keeps its worker
// beating, so a live-but-hung holder is indistinguishable from a healthy
// slow one and would be waited out FOREVER — the waiter is a synchronous
// poll on the caller's main thread, so the whole server's event loop
// stalls for the wedge (measured: 59.7s on a 60s wedge; still blocked at
// 20s; zero event-loop turns). The honest rule, now stated: a live-beating
// holder is PROBABLY productive, and a probably-productive holder is
// waited out — but only up to a hard total cap (LEDGER_MAX_WAIT_MS).
// Past the cap the waiter degrades to the additive-spool append: the
// ledger is best-effort by contract, an approved call never stalls
// unboundedly, and dead holders (immediate reclaim) and empty stale dirs
// (1s) keep their current behavior under the cap. The cap applies to
// healthy sections too by design: a healthy section longer than the cap
// makes concurrent waiters degrade — their events land additively in the
// spool instead of racing the holder's whole-file write (round 6: the
// unlocked whole-file write re-opened the round-4 erasure at 1.4M events
// and on slow homes, both writers rc=0, the committed event gone).
const LEDGER_LOCK_TAKEOVER_MS = 1_000;
const LEDGER_HEARTBEAT_MS = 200;
// The hard total-wait cap (round 5): well under the 5s bar the round-3
// stall probes set. Round 6 falsified the "above every healthy-section
// shape" sizing claim (a 1.4M-event store measures 4.1s; a slow home has
// no ceiling) — the cap no longer pretends to bound healthy sections; it
// bounds the CALLER's stall, and the additive spool carries the evidence
// for whatever runs past it.
const LEDGER_MAX_WAIT_MS = 3_000;

// Degraded-section re-entrancy (round 6, finding 1): when >0, this process
// is inside a degraded (unlocked) ledger section. Nested ledger calls
// skip acquisition entirely — a second withDepLock attempt would pay the
// wait cap AGAIN (recordAskModeConsent's section calls appendConsentEvent;
// the gate's ask path measured 6.05-6.09s on a wedged holder, 2× the cap
// the bar was sized for) — and their appends route to the additive spool,
// never to an unlocked whole-file write.
let degradedDepth = 0;

// The filtered view consumers read: every entry that parses to the
// ConsentEvent shape, from the main store AND the degraded spool (round 6:
// a spooled event is a committed event — the reader must see it). Malformed
// entries read as absent — read tolerance is fine; the WRITE path never
// uses this view (it preserves raw entries).
export function readConsentEvents(): ConsentEvent[] {
  const out = filterEvents(readRawConsents() ?? []);
  for (const line of spoolLines()) {
    const parsed = parseSpoolLine(line);
    if (parsed !== undefined) out.push(...filterEvents([parsed.parsed]));
  }
  return out;
}

function filterEvents(entries: unknown[]): ConsentEvent[] {
  const out: ConsentEvent[] = [];
  for (const entry of entries) {
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

// The spool's raw lines, best-effort: every non-empty line as text. A line
// that does not parse degrades to skipped in the filtered view and is
// preserved verbatim at compaction (the raw-preservation doctrine).
function spoolLines(): string[] {
  try {
    const path = ledgerSpoolPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function parseSpoolLine(line: string): { parsed: unknown } | undefined {
  try {
    return { parsed: JSON.parse(line) };
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

// The degraded append (round 6, finding 2): strictly additive. One JSON
// line per event, append mode — the whole-file O_APPEND protocol cannot
// erase anything, because it never reads or rewrites the store. Concurrent
// degraded writers interleave lines; the kernel serializes the
// size-update+write per open descriptor, and each line is a single small
// write.
function spoolAppend(events: ConsentEvent[]): void {
  try {
    const path = ledgerSpoolPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // same degradation contract as the locked write: never fail the call
  }
}

// Take the spool under the lock, atomically: rename moves every line
// already appended into a per-compaction file; a degraded writer appending
// after the rename lands in a FRESH spool (append mode creates it) and
// waits for the next compaction. Returns the taken files' raw contents —
// parseable events plus any unparseable line preserved verbatim as a
// string element (the raw-preservation doctrine: the compaction may
// reorder, never erase).
function takeSpool(): { events: unknown[]; taken: string[] } {
  const spool = ledgerSpoolPath();
  const taken: string[] = [];
  const events: unknown[] = [];
  const fold = (file: string): void => {
    try {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      for (const line of lines) {
        const parsed = parseSpoolLine(line);
        if (parsed === undefined) events.push(line);
        else events.push(parsed.parsed);
      }
    } catch {
      // unreadable taken file: leave it for the next compaction
    }
  };
  try {
    if (existsSync(spool)) {
      const takenFile = `${spool}.taken-${process.pid}-${randomUUID()}`;
      renameSync(spool, takenFile);
      taken.push(takenFile);
      fold(takenFile);
    }
  } catch {
    // the rename raced a concurrent compaction or failed: the spool stays
    // for the next holder; nothing is lost
  }
  // Stale taken files from a compaction that crashed after its main write
  // (its events are already in the store): folding them again duplicates
  // those lines — the safe direction, documented residual; a crash BEFORE
  // the write is why they must be folded at all.
  try {
    for (const entry of readdirSync(dirname(spool))) {
      if (entry.includes('.spool.jsonl.taken-')) {
        const stale = join(dirname(spool), entry);
        if (!taken.includes(stale)) {
          taken.push(stale);
          fold(stale);
        }
      }
    }
  } catch {
    // unreadable directory: the next compaction retries
  }
  return { events, taken };
}

// The locked append core: read the raw store, quarantine an unreadable
// one, compact the spool, write existing-plus-spoolevents-plus-events.
// Runs ONLY inside a withDepLock hold — the public functions acquire it
// (and re-entrancy makes a nested call from inside another hold safe, so
// the tier resolution in recordAskModeConsent and the append share ONE
// serialized section). The WHOLE body is best-effort (interrogate round 4):
// every internal failure — the store-path resolution included (a relative
// HUAWEICLOUD_STATE_DIR makes devkitStateBase throw INSIDE the lock), any
// fs error, the quarantine rename — degrades internally, so lockedAppend
// CANNOT throw. That invariant, now true, is what lets withLedgerLock
// treat any exception from withDepLock as an acquisition failure, and lets
// the ledger honor its contract: an internal failure degrades the audit
// trail, never the approved call (trunk recorded no consent at all).
function lockedAppend(events: ConsentEvent[]): void {
  try {
    const path = ledgerFilePath();
    // The spool is taken FIRST, inside the lock: its lines plus the new
    // events land in the main store in one write, and a degraded writer
    // racing this compaction appends to the fresh spool the rename left
    // behind — no window, no loss.
    const spool = takeSpool();
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
      writeFileSync(tmp, JSON.stringify([...existing, ...spool.events, ...events]), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // same degradation contract as writeApprovals in approval-tokens.ts
      return; // the main write failed: keep the taken files for the next compaction
    }
    // The taken spool files are removed only after the main write landed.
    // A crash between write and removal duplicates their lines at the next
    // compaction — the safe direction (additive), documented residual.
    for (const file of spool.taken) {
      try {
        rmSync(file, { force: true });
      } catch {
        // the stale-taken sweep at the next compaction reclaims it
      }
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
// HUAWEICLOUD_STATE_DIR makes throw) proceeds DEGRADED instead of
// surfacing. A body failure is a different fact: the bodyRan flag makes
// the catch a no-op once the body started, so the append body never runs
// twice and a body-internal throw (impossible by lockedAppend's hardening,
// but held defensively) degrades to a no-op rather than a second attempt.
// The heartbeat rides on the same acquisition, keeping a live section
// claim-fresh for its whole duration (interrogate round 4).
function withLedgerLock(fn: () => void): void {
  // Degraded-section re-entrancy (round 6, finding 1): inside a degraded
  // section there is no lock to contend for — acquiring again would pay
  // the wait cap a second time (2× the bound on the gate's ask path).
  if (degradedDepth > 0) {
    fn();
    return;
  }
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
      LEDGER_MAX_WAIT_MS,
    );
  } catch {
    // Acquisition failures (unhostable tree, read-only claim path) and the
    // round-5 wait-budget throw share this posture: the body has not run,
    // so it runs DEGRADED — the ledger is best-effort, an approved call
    // never blocks unboundedly on a lock, and a body-internal throw (made
    // impossible by the hardened bodies) is held defensively. The
    // degradedDepth marker makes the section re-entrant (no second cap)
    // and routes every append inside it to the additive spool.
    if (!bodyRan) {
      degradedDepth += 1;
      try {
        fn();
      } finally {
        degradedDepth -= 1;
      }
    }
  }
}

// Best-effort append, same failure posture as the approvals store: an
// in-file failure degrades the audit trail but never fails the call the
// user just approved — with one carve-out: a store that exists but cannot
// be read is never overwritten (it is quarantined with its bytes intact
// first, and the append is dropped when even that fails). With a lock in
// hand the whole read-modify-write runs under the per-store file lock, so
// concurrent appenders — separate MCP server processes on one machine —
// serialize. Without a lock (wedged holder, over-cap section, unhostable
// tree) the append goes to the ADDITIVE SPOOL — a degraded whole-file
// write would race the locked holder's own write and erase whatever
// commits between the degraded read and the degraded rename (round 6,
// finding 2: rc=0 on both sides, the committed event gone). The spool
// appends one line and never reads the store, so nothing committed can be
// erased; the next locked append compacts it.
export function appendConsentEvent(event: ConsentEvent): void {
  // Inside a degraded section already: additive, no acquisition attempt.
  if (degradedDepth > 0) {
    spoolAppend([event]);
    return;
  }
  try {
    withDepLock(
      () => lockedAppend([event]),
      ledgerLockDir(),
      LEDGER_LOCK_TAKEOVER_MS,
      LEDGER_HEARTBEAT_MS,
      LEDGER_MAX_WAIT_MS,
    );
  } catch {
    // Acquisition failed (budget, unhostable tree, read-only claim): the
    // spool is the degraded append — lockedAppend never runs unlocked.
    spoolAppend([event]);
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
  // confirmations in the later PRs). The resolution and the append share
  // ONE section (locked: one hold; degraded: one synchronous block with
  // the spool routing), so two racing arrivals on the same key both
  // resolve against the store the other left, not a stale snapshot. A
  // resolution failure (an unreadable store the hardened read already
  // degrades to empty, a state-dir validation throw) degrades to the
  // caller's tier so the append still lands — the same best-effort
  // posture as the append itself (interrogate round 4).
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
