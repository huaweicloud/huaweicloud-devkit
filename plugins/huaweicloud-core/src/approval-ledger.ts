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
// ENFORCES the inheritance by resolving the tier itself from the original
// granted event on the same consent key (sessionId + tool + argsHash —
// the earliest granted event by chronology, round 8; at an exact
// same-millisecond cross-tier tie, where chronology cannot name the
// original, the WEAKEST tier present wins — round 10's never-upgrade
// direction, with the rare mis-grade DOWN as the recorded honest cost):
// the caller's evidence parameter is consulted only when no granted
// original exists.
//
// PR-3a contract (round 10, G2, recorded for the landing PR — no code in
// PR-1 beyond this note): the S3 session standing consent needs a
// tier-safe writer this ledger does not export yet — recordAskModeConsent
// hard-codes scope 'once' and takes no scope parameter, and
// appendConsentEvent takes the scope but does no tier resolution, so a
// standing grant or memo event routed through the latter would upgrade
// unchecked. The standing writer PR-3a lands MUST resolve the tier
// exactly the way recordAskModeConsent does (chronology, weakest-wins tie)
// and take the scope as a parameter; and the gate's ask result must first
// become a structured value carrying approvedVia (a gate-contract change
// in approval-gate.ts AND tools.ts, the latter unlisted in PR-3a's file
// list) before the memo can report what it reused.
//
// Write discipline (interrogate rounds 1-7): an append ADDS, it never
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
//
// Round 7 hardened the same surface at three points the seats measured:
// the spool append inspects and terminates a torn tail before adding its
// line (a partial write must not glue — and thereby hide — the next
// committed event); the reader folds the .taken-* compaction sidecars into
// the view (an event is committed the moment its line is on disk, not the
// moment a compaction lands it in the store — a tier-inheritance lookup
// during the take-write window resolved against a store that did not
// carry the original); and a compaction never deletes a taken file it
// failed to read (the bytes survive on disk for the next compaction to
// retry).
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import { withDepLock } from './dep/receipts.ts';
import type { ConsentDeliveryOutcome, ConsentEvent, ConsentEvidence } from './approval-types.ts';

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

// The arrival counter's high-water file (round 13, finding 4; hardened
// round 14, findings 1-2): the last sequence number assigned, a few bytes
// beside the store. The counter is CLOCK-INDEPENDENT by construction —
// grantedAt can step backward under an NTP correction or a VM restore, and
// the (arrivalSeq, grantedAt) chronology key must still name the true
// original. Assignment: read the file, bump, write back atomically
// (tmp+rename). The FLOOR IS THE STORE (round 14, finding 1, both seats):
// the file is an optimization over the source of truth — whenever its read
// fails, yields a non-number, or carries a value at or below the store's
// own max arrivalSeq, the counter seeds from max(store seq) instead, so a
// lost, corrupted, or rewound file can never stamp a new arrival with a
// seq an EXISTING row already owns (measured: a missing file over a
// non-empty store named a later-written copy the original — the fabricated
// upgrade the counter was built to prevent, with no clock skew; a
// non-numeric file rewound the counter to 0 under a seq-2 store and three
// serialized writers re-took 0,1,2). A row whose seq could not be
// determined even then — the store read itself failed — sorts NEWEST
// (SEQ_UNKNOWN, a sentinel that loses to every real seq), never oldest:
// a failed counter read means UNKNOWN, not 'first'. The write back is
// monotonic: a value at or below the store's max is never written. The
// assignment runs INSIDE the ledger lock's hold (round 14, finding 2,
// both seats): the raw appendConsentEvent face used to assign before
// withDepLock, and 24 concurrent writers duplicated 13 seq groups — the
// locked body (lockedAppend) and the degraded body assign under the
// lock/degraded-section discipline, so locked writers serialize for real
// (the degraded path remains the recorded duplicate residual: it cannot
// hold the lock, its read-write races, and equal seqs fall to grantedAt
// with weakest-wins governing the exact tie — and its store read at
// assignment time seeds from the merged view's max).
function ledgerSeqPath(): string {
  return join(devkitStateBase(), 'approval-consents.seq');
}

// The unknown-seq sentinel: sorts AFTER every real seq, so a row the
// counter could not number is never mistaken for the earliest arrival.
const SEQ_UNKNOWN = Number.MAX_SAFE_INTEGER;

// The store's highest assigned seq — the counter's floor. Scans the merged
// view (a degraded arrival compacted later still owns its seq), skipping
// the unknown sentinel. Best-effort like every read here: on failure the
// caller takes the sentinel, never a rewind.
function maxArrivalSeqInStore(): number {
  let max = -1;
  for (const event of readConsentEvents()) {
    if (event.arrivalSeq !== SEQ_UNKNOWN && event.arrivalSeq > max) max = event.arrivalSeq;
  }
  return max;
}

function nextArrivalSeq(): number {
  let next: number;
  try {
    const path = ledgerSeqPath();
    let current = Number.NaN;
    try {
      if (existsSync(path)) {
        const parsed = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
        if (Number.isFinite(parsed)) current = parsed;
      }
    } catch {
      current = Number.NaN; // unreadable: the store floors the counter
    }
    const storeMax = maxArrivalSeqInStore();
    // Never trust a file that rewinds under (or ties) the store's max.
    if (!(current > storeMax)) current = storeMax;
    next = current + 1;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.seq.tmp`;
      writeFileSync(tmp, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // the write-back is best-effort; the row still carries `next`
    }
  } catch {
    next = SEQ_UNKNOWN; // the store read itself failed: unknown, never oldest
  }
  return next;
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
// ConsentEvent shape, from the main store, the degraded spool, AND every
// .taken-* file beside it. The taken fold (round 7, finding 2) closes the
// compaction's reader-blind window: takeSpool renames the spool away
// BEFORE the main write, and when that write fails or crashes the taken
// file deliberately survives — without the fold, a tier-inheritance reuse
// in that window resolved against a store that did not yet carry the
// original and mis-recorded the tier (measured: a terminal original
// re-recorded as posture, permanently).
//
// The three sources are read at three different instants, so the SAMPLING
// order and the ARRAY order are chosen separately, and each for a distinct
// reason. Sampling order: spool, then taken, then store. An event moves
// spool → taken → (store + removal) as a compaction proceeds; a pass that
// samples the slow store FIRST can read the pre-write store and then, a
// read later, find the taken file already removed — assembling a view from
// a state gap no single instant had (measured: one absent sample through
// a real 400k compaction). Sampling the small spool and taken files first
// closes every gap: by the time the slow store read opens, the event is
// either still in the taken file or already in the store it reads. Array
// order: store, then spool, then taken — DISPLAY order only. No ordering
// choice here can affect an inheritance decision (round 8): the tier
// resolution resolves the original by CHRONOLOGY and ignores array
// position entirely, because fold order is not chronology — the taken
// sidecars sort by a pid+UUID name, and after a stale-taken recovery even
// the store's own row order is not chronological (a newer copy can land
// below the older original it was folded ahead of). A taken file the
// reader cannot read (a fold failure leaves it on disk, round 7 finding 3)
// is skipped here the same way the fold skips it — the file survives with
// its bytes. Malformed entries read as absent — read tolerance is fine;
// the WRITE path never uses this view (it preserves raw entries).
export function readConsentEvents(): ConsentEvent[] {
  const sampledSpool = spoolLines();
  const sampledTaken = takenSpoolFiles().flatMap((file) => spoolLinesOf(file));
  const foldIntoView = (lines: string[], out: ConsentEvent[]): void => {
    for (const line of lines) {
      const parsed = parseSpoolLine(line);
      if (parsed !== undefined) out.push(...filterEvents([parsed.parsed]));
    }
  };
  const out = filterEvents(readRawConsents() ?? []);
  const storeRowCount = out.length;
  foldIntoView(sampledSpool, out);
  foldIntoView(sampledTaken, out);
  // The delivery-outcome side channel (rounds 12-13): attaches the
  // annotate's lines to the STORE-resident rows they name, after every
  // source is folded — one pass, store rows only (the annotate guard's
  // own semantics: a degraded twin never receives a line).
  applyOutcomeLines(out, storeRowCount);
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
      (record.evidence !== 'terminal' && record.evidence !== 'elicitation' && record.evidence !== 'posture') ||
      typeof record.arrivalSeq !== 'number'
    ) {
      continue;
    }
    const event: ConsentEvent = {
      sessionId: record.sessionId,
      tool: record.tool,
      argsHash: record.argsHash,
      outcome: record.outcome,
      grantedAt: record.grantedAt,
      scope: record.scope,
      evidence: record.evidence,
      arrivalSeq: record.arrivalSeq,
    };
    // The delivery-outcome follow-up (round 10, finding 4): pass it through
    // when present and well-formed; a malformed value reads as absent (the
    // documented read tolerance — the write path preserves the raw row).
    if (
      record.outcomeDetail === 'delivered' ||
      record.outcomeDetail === 'uncertain' ||
      record.outcomeDetail === 'failed'
    ) {
      event.outcomeDetail = record.outcomeDetail;
    }
    out.push(event);
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
  return spoolLinesOf(ledgerSpoolPath());
}

// The same best-effort line extraction over any spool-shaped file: the
// spool itself, or a .taken-* compaction sidecar. An absent or unreadable
// file reads as no lines (round 7, finding 3: the fold keeps unreadable
// taken files on disk — the reader skipping them is what keeps a
// mid-fold-failure compaction from losing the main write).
function spoolLinesOf(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

// Every .taken-* file beside the spool, sorted for a deterministic view.
// These are compaction sidecars: the in-flight take of the current spool,
// or the deliberate survivors of a failed or crashed compaction (kept for
// the next compaction's stale-taken sweep) — the same name shape the
// sweep matches.
function takenSpoolFiles(): string[] {
  try {
    const spool = ledgerSpoolPath();
    const dir = dirname(spool);
    return readdirSync(dir)
      .filter((entry) => entry.includes('.spool.jsonl.taken-'))
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => join(dir, entry));
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

// The additive line-append primitive (rounds 6-7, generalized round 12):
// one JSON line through one O_APPEND fd the writer first inspects —
// open, read the byte at the end, write a '\n' terminator when that byte
// is not a newline, then write the line. Never a rewrite of existing
// bytes; strictly additive; the whole-file O_APPEND protocol cannot
// erase anything because it never reads or rewrites the file it appends
// to. Concurrent appenders interleave lines; the kernel serializes the
// size-update+write per open descriptor, and each line is a single small
// write. The tail inspection is the round-7 discipline: a torn tail (a
// disk-full clamp, a crash mid-append, a short write) must not GLUE the
// next committed line onto the fragment — the terminator isolates it.
function appendLineAdditively(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a+', 0o600);
    try {
      const start = fstatSync(fd).size;
      if (start > 0) {
        const tail = new Uint8Array(1);
        const read = readSync(fd, tail, 0, 1, start - 1);
        if (read === 1 && tail[0] !== 0x0a) writeSync(fd, '\n');
      }
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    // same degradation contract as the locked write: never fail the call
  }
}

// The degraded append (round 6, finding 2): strictly additive. One JSON
// line per event to the spool — no read, no rewrite of the store. The
// path resolution stays INSIDE the degradation catch (a relative
// HUAWEICLOUD_STATE_DIR makes it throw — the round-4 posture: a
// ledger-internal failure never fails the approved call).
function spoolAppend(events: ConsentEvent[]): void {
  try {
    appendLineAdditively(ledgerSpoolPath(), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
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
// reorder, never erase) — plus the list of files that folded SUCCESSFULLY,
// the only ones the caller may remove. A file whose read fails (round 7,
// finding 3: a spool past V8's max string length throws
// ERR_STRING_TOO_LONG on readFileSync; EMFILE and EIO are the same class)
// is kept in place with its bytes — "leave it for the next compaction" is
// now literally true — and the next compaction's stale-taken sweep
// retries it. The main write is not held hostage to the failure.
function takeSpool(): { events: unknown[]; folded: string[] } {
  const spool = ledgerSpoolPath();
  const folded: string[] = [];
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
      folded.push(file);
    } catch {
      // read failure: keep the file in place, bytes intact — evidence is
      // never deleted on a read failure; the next compaction retries
    }
  };
  try {
    if (existsSync(spool)) {
      const takenFile = `${spool}.taken-${process.pid}-${randomUUID()}`;
      renameSync(spool, takenFile);
      fold(takenFile);
    }
  } catch {
    // the rename raced a concurrent compaction or failed: the spool stays
    // for the next holder; nothing is lost
  }
  // Stale taken files from a compaction that crashed after its main write
  // (its events are already in the store): folding them again duplicates
  // those lines — the safe direction, documented residual; a crash BEFORE
  // the write is why they must be folded at all. Unreadable ones stay and
  // are retried here every compaction until they fold or an operator
  // looks at them (documented residual: a spool past V8's string limit
  // never folds through this path).
  for (const file of takenSpoolFiles()) {
    if (!folded.includes(file)) fold(file);
  }
  return { events, folded };
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
    // The taken spool files are removed only after the main write landed,
    // and only the ones that folded successfully (round 7, finding 3) — an
    // unfolded file is evidence the store does not carry, so removing it
    // would silently drop every consent line it holds. A crash between
    // write and removal duplicates the folded lines at the next
    // compaction — the safe direction (additive), documented residual.
    for (const file of spool.folded) {
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
  // The seq assignment rides inside the write bodies (round 14, finding 2,
  // both seats): the locked body assigns under the ledger lock's hold, so
  // locked writers serialize for real; the degraded body assigns inside
  // its own degraded section. The caller cannot game or clock-order it —
  // whatever it passed is overwritten.
  if (degradedDepth > 0) {
    event.arrivalSeq = nextArrivalSeq();
    spoolAppend([event]);
    return;
  }
  try {
    withDepLock(
      () => {
        // Assigned INSIDE the hold (round 14, finding 2, both seats): the
        // raw append face used to assign before withDepLock, and 24
        // concurrent writers duplicated 13 seq groups. Under the lock the
        // read-bump-write is serialized with every other locked assigner
        // (the degraded assigner cannot take the lock and remains the
        // recorded duplicate residual).
        event.arrivalSeq = nextArrivalSeq();
        lockedAppend([event]);
      },
      ledgerLockDir(),
      LEDGER_LOCK_TAKEOVER_MS,
      LEDGER_HEARTBEAT_MS,
      LEDGER_MAX_WAIT_MS,
    );
  } catch {
    // Acquisition failed (budget, unhostable tree, read-only claim): the
    // spool is the degraded append — lockedAppend never runs unlocked.
    // The counter assignment here is unlocked (the degraded path cannot
    // hold the lock): it seeds from the merged view's max, and two
    // concurrent degraded arrivals racing the read-derive can take the
    // same number — the recorded duplicate residual, tolerable because
    // equal seqs fall to grantedAt and weakest-wins governs the exact
    // tie.
    event.arrivalSeq = nextArrivalSeq();
    spoolAppend([event]);
  }
}

// The ORIGINAL granted event on this consent key: the one a memo-reuse
// inherits its evidence tier from. A denied arrival is not a consent — a
// retry after one is a fresh ask, not a reuse.
//
// Round 8, finding 1 (both seats): the original is resolved by
// CHRONOLOGY — the earliest arrival on the key, keyed (arrivalSeq,
// grantedAt) since round 13 — never by array position. The merged view's order is fold order (store, spool, then
// .taken-* sidecars in name order — a pid+UUID artifact with no relation
// to chronology, and after a stale-taken recovery even the store's own
// row order is not chronological), and a recovery state can hold the
// same key in several sources at once: the terminal original in one
// sidecar, a mis-recorded posture copy — born when a transient read
// failure hid the original — in another. Taking the last array element
// handed the inheritance to whichever random UUID name-sorted last
// (measured: a controlled pair flipped terminal/posture on the name
// order alone; the organic chain mis-inherited deterministically; the
// real API downgraded on half the runs). Chronology is the rule the plan
// states — a reuse inherits the ORIGINAL event's tier — and it is also
// the self-consistent one: every reuse row re-records the inherited
// tier, so in a healthy chain every granted row on the key carries the
// original's tier and the scan direction is invisible; only the
// failure-born copy differs, and it is always the NEWER row — except at
// an exact millisecond collision (round 9, finding 1: the same-ms
// boundary reopened the round-8 defect — the strict-< incumbent kept
// the FIRST row in array order, which is fold order, so the copy won
// whenever its host name-sorted or folded first; measured 10/20 wrong on
// the taken pair, three of six host cells wrong 20/20, the first
// compaction baking the pick into the store permanently). At such a tie
// chronology cannot distinguish the rows, so the tiebreak is CONTENT —
// but round 10, finding 1 (both seats) fixed its direction: the WEAKEST
// tier present wins (posture < elicitation < terminal), a function of
// the rows' own content and never of the fold order, and the only
// direction the plan's never-upgrade line survives — see
// TIER_PRECEDENCE below for the honest cost.

// Tier precedence for the equal-chronology tiebreak (rounds 9-10): the
// strength of the HUMAN evidence behind the consent — a terminal
// confirmation outranks an elicitation response, which outranks a
// posture-grade arrival. Pure data, keyed by the evidence model, with no
// undefined case (the filtered view only yields these three tiers). The
// table NAMES the strength order; round 10, finding 1 (both seats) fixed
// the DIRECTION it is consulted in: at an exact cross-tier tie the WEAKEST
// tier present wins, never the strongest. The round-9 strongest-wins rule
// was an UPGRADE path — a posture-grade original with a stronger-tier
// same-millisecond copy re-recorded elicitation/terminal over it (10/10
// in both stagings, all six host cells, the locked path baking it
// permanently), violating the plan line ("inherits the evidence tier of
// the original event it reuses and never upgrades it, so a posture-grade
// yes can never be re-recorded as terminal-grade on retry"). At an exact
// tie chronology cannot name the original, so no tiebreak can recover
// originality — the only plan-conforming direction is the SAFE one: the
// weakest tier present. The honest cost, recorded: the r9 cell (a
// terminal original beside a posture copy at the same stamp) now records
// posture — a rare mis-grade DOWN. That is the correct trade: a mis-grade
// down never fabricates stronger evidence, while a mis-grade up does.
const TIER_PRECEDENCE: Record<ConsentEvidence, number> = { posture: 0, elicitation: 1, terminal: 2 };

function originalGrantedFor(sessionId: string, tool: string, argsHash: string): ConsentEvent | undefined {
  const events = readConsentEvents();
  let original: ConsentEvent | undefined;
  for (const event of events) {
    if (
      event.sessionId !== sessionId ||
      event.tool !== tool ||
      event.argsHash !== argsHash ||
      event.outcome !== 'granted'
    ) {
      continue;
    }
    if (original === undefined || event.arrivalSeq < original.arrivalSeq) {
      original = event;
      continue;
    }
    if (event.arrivalSeq === original.arrivalSeq && event.grantedAt < original.grantedAt) {
      original = event;
      continue;
    }
    // Round 9, finding 1 (both seats) + round 10, finding 1 (both seats):
    // an EXACT grantedAt collision between rows with DIFFERENT tiers was
    // first resolved by array position — fold order — so a
    // same-millisecond failure-born posture copy could win the
    // inheritance whenever its host name-sorted or folded first. Round 9
    // replaced position with content: tier precedence, strongest wins.
    // Round 10 falsified the DIRECTION: strongest-wins is an UPGRADE path
    // — a posture-grade original with a stronger-tier same-ms copy
    // re-recorded the stronger tier over it (10/10 in three stagings, all
    // six host cells, the locked path permanent), the exact sentence the
    // plan forbids. At a tie chronology cannot distinguish the rows, and
    // it cannot name the original either — so the tiebreak resolves to
    // the WEAKEST tier present: downgrade-safe, upgrade-impossible. The
    // honest cost: a terminal original beside a weaker same-ms copy
    // records the weaker tier — a rare mis-grade DOWN, never a fabricated
    // upgrade. At a tie with EQUAL tiers the choice is immaterial (both
    // rows carry the same tier; the incumbent stays).
    //
    // Round 13, finding 4: the primary key is the ARRIVAL SEQUENCE, not
    // grantedAt — grantedAt steps backward under an NTP/VM-restore clock
    // correction, and a later-written failure-born copy with a smaller
    // stamp then won strict chronology (measured: a posture original
    // re-recorded as terminal, no tiebreak firing because the stamps
    // differ). The counter is assigned per append from the high-water
    // file, so it tracks real arrival order whatever the wall clock did;
    // grantedAt stays the key within an equal-seq collision (concurrent
    // degraded arrivals can race the unlocked counter read-write and take
    // the same number) and the weakest-wins rule governs the exact
    // (seq, grantedAt) tie.
    if (
      event.arrivalSeq === original.arrivalSeq &&
      event.grantedAt === original.grantedAt &&
      TIER_PRECEDENCE[event.evidence] < TIER_PRECEDENCE[original.evidence]
    ) {
      original = event;
    }
  }
  return original;
}

// Returns the arrival's grantedAt stamp — the identity the dispatch layer
// hands to annotateDispatchOutcome so the delivery outcome can be keyed to
// EXACTLY the row this arrival wrote (round 12, finding 2: ownership is
// proven by the stamp, never by absence — an append the best-effort catch
// drops leaves a stamp no row matches, and the annotate then no-ops
// instead of stamping an earlier call's row).
export function recordAskModeConsent(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  outcome: 'granted' | 'denied';
  evidence?: ConsentEvidence;
  arrivalSeq?: number;
}): number {
  // Tier resolution is the ledger's rule, not the caller's: a reuse
  // inherits the original event's tier verbatim — never upgraded (posture
  // stays posture when the caller asks for terminal); the one sanctioned
  // downgrade is the exact same-millisecond cross-tier tie, where
  // chronology cannot name the original and the WEAKEST tier present wins
  // (round 10, finding 1 — a rare mis-grade DOWN, never a fabricated
  // upgrade). Only a FRESH key takes the caller's evidence (posture for
  // ask arrivals, terminal for approve-CLI confirmations in the later
  // PRs). The ORIGINAL is resolved by chronology (round 8): the earliest
  // granted event on the key, wherever it lives — a recovery state can
  // hold the same key in the store, the spool, and several .taken-*
  // sidecars at once, and the failure-born mis-tiered copy is always the
  // NEWER row, so the earliest granted row is the original by
  // construction — except at the exact-tie boundary, where the
  // weakest-wins rule above is the only plan-conforming answer. The
  // resolution and the append share ONE section (locked: one hold;
  // degraded: one synchronous block with the spool routing), so two
  // racing arrivals on the same key both resolve against the store the
  // other left, not a stale snapshot. A resolution failure (an unreadable
  // store the hardened read already degrades to empty, a state-dir
  // validation throw) degrades to the caller's tier so the append still
  // lands — the same best-effort posture as the append itself
  // (interrogate round 4).
  const grantedAt = Date.now();
  withLedgerLock(() => {
    let evidence = params.evidence ?? 'posture';
    try {
      const original = originalGrantedFor(params.sessionId, params.tool, params.argsHash);
      if (original) evidence = original.evidence;
    } catch {
      // degrade to the caller's tier: the append is the fact that matters
    }
    appendConsentEvent({
      sessionId: params.sessionId,
      tool: params.tool,
      argsHash: params.argsHash,
      outcome: params.outcome,
      grantedAt,
      scope: 'once',
      evidence,
      arrivalSeq: 0, // appendConsentEvent assigns the real counter
    });
  });
  return grantedAt;
}

// The delivery-outcome follow-up (round 10, finding 4, both seats' shape;
// PR-3a's memo datum): annotate the most recent granted consent row on a
// key with what became of the call the consent authorized. The gate
// records the ARRIVAL (recordAskModeConsent, above); the dispatch layer —
// which is the only place that ever sees the handler's return or throw —
// calls this best-effort follow-up after the handler ran. The ledger's
// subject widens accordingly: the CONSENT's lifecycle (arrival + what
// became of the call it authorized), never the handler's internal
// execution. PR-3a's S1 memo keys reuse on this datum (uncertain /
// failed → reuse the prior consent; delivered → no reuse).
//
// Best-effort in every direction, by design: the annotation takes the
// ledger lock under a SHORT wait budget (a wedged holder must not tax the
// approved call's tail a second time after the arrival already paid the
// 3s cap) and SKIPS on any failure — lock unobtainable, no store, an
// unreadable store (the quarantine is the append's business; this path
// never rewrites a store it could not read), or the row not found. "Not
// found" is the common healthy skip: token mode records no arrival
// (nothing to annotate), a classified pass-through records none either,
// and a consent whose arrival degraded to the spool or a taken sidecar
// is left alone — enforced (round 11, finding 1, both seats), not just
// promised: pre-fix, the store-only target scan stamped this call's
// outcome over an EARLIER arrival's committed row in exactly that
// state (sequential, deterministic, the ~3s healthy-section band), so
// the annotate now resolves the newest granted row on the key through
// the MERGED reader (store + spool + taken) first and skips entirely
// unless that row is the store row this dispatch's own arrival wrote —
// rewriting a spool line stays forbidden (the unlocked read-rewrite
// this ledger forbids, round 6), and so does rewriting another
// arrival's store row. A skipped annotation leaves the row as the
// arrival wrote it; the memo treats an absent outcomeDetail as unknown.
// The update itself is an in-place field write on ONE row under the
// lock — the same locked read-modify-write shape as lockedAppend. The
// recorded residual narrows to the RACING shape alone: concurrent
// same-key arrivals can interleave between this call's arrival and its
// annotate so the newest store row is not provably this dispatch's own
// — PR-3a's precise keyed join lands with the approvedVia carrier (the
// recorded G2 note).
// The newest granted stamp on a consent key among the rows OUTSIDE the
// main store (the spool and every .taken-* sidecar) — the merged-world
// leg of the annotate's targeting guard (round 11, finding 1). A spool
// or taken line is a committed event (round 7), so the annotate must
// treat its stamp as authoritative when deciding which row is the
// newest consent on the key. Read tolerance matches the filtered view:
// a line that does not parse, or a row that does not match the key or
// is not granted, contributes nothing.
function newestGrantedStampOutsideStore(params: { sessionId: string; tool: string; argsHash: string }): number {
  let newest = Number.NEGATIVE_INFINITY;
  const consider = (lines: string[]): void => {
    for (const line of lines) {
      const parsed = parseSpoolLine(line);
      if (parsed === undefined) continue;
      const record = parsed.parsed;
      if (!record || typeof record !== 'object') continue;
      const row = record as Record<string, unknown>;
      if (
        row.sessionId === params.sessionId &&
        row.tool === params.tool &&
        row.argsHash === params.argsHash &&
        row.outcome === 'granted' &&
        typeof row.grantedAt === 'number' &&
        row.grantedAt > newest
      ) {
        newest = row.grantedAt;
      }
    }
  };
  consider(spoolLines());
  for (const file of takenSpoolFiles()) {
    consider(spoolLinesOf(file));
  }
  return newest;
}

// The delivery-outcome side channel (round 12, finding 4): one JSON line
// per annotate, keyed by the arrival's stamp —
// {sessionId, tool, argsHash, grantedAt, outcomeDetail}. Additive in both
// directions: the append can erase nothing (the same O_APPEND discipline
// as the spool), and the reader attaches a line only to the consent row
// whose stamp it names. The annotate that writes here never touches the
// main store at all, which is the whole point: rounds 10-11's annotate
// was a third whole-file writer, and a heartbeat-less holder legitimately
// deposed past the 1s takeover window could commit its lockedAppend
// INSIDE the annotate's read→rename window — the annotate's stale-snapshot
// rename then erased the holder's committed event (measured: gone from
// every source, both writers rc=0), the round-6 erasure class reopened
// through the writer that landed after the round-6 fix. The annotate is
// now LOCKLESS as well as additive: it neither writes the store nor
// needs serialization, so it can neither race a store commit nor depose
// a live holder. Growth is append-only (one small line per annotated
// dispatch — slower than the spool, which carries a full row per
// arrival); a compaction that folds lines into store rows is honest
// future work, not PR-1.
function ledgerOutcomePath(): string {
  return `${ledgerFilePath()}.outcomes.jsonl`;
}

interface OutcomeLine {
  sessionId: string;
  tool: string;
  argsHash: string;
  grantedAt: number;
  outcomeDetail: ConsentDeliveryOutcome;
  // The arrival's seq (round 14, finding 4): captured by the annotate
  // from the row its guard verified, so the fold binds to the exact row
  // whatever any compaction did to the store order. Absent on lines
  // written before the field or when the row's seq was the unknown
  // sentinel — those fall back to the key+stamp rule.
  arrivalSeq?: number;
}

// Attach the outcome lines to the merged view (rounds 12-14): each line
// names the consent row it annotates by the arrival's stamp AND — since
// round 14, finding 4 — the arrival's SEQ, captured by the annotate from
// the very row its guard verified. The compaction always folds spool rows
// AFTER existing store rows, so a same-ms degraded twin compacted by the
// next ordinary append lands BEHIND the annotated row and the key+stamp
// fold handed the line to the twin (the row that annotated lost it). The
// seq exists precisely to disambiguate: a line carrying a seq binds to the
// store row matching (key, stamp, seq) — the exact row, whatever any
// compaction did to the order; a legacy line with no seq falls back to
// the key+stamp last-store-row rule (the r13 same-ms store rule). A
// degraded twin never receives a line either way: the annotate's guard
// never wrote one for it, and its own seq differs from the line's.
// Round 13, finding 2's doctrine and finding 1's one-pass shape both
// hold: store rows only, Map-indexed, O(store + lines).
function applyOutcomeLines(out: ConsentEvent[], storeRowCount: number): void {
  let lines: string[];
  try {
    const path = ledgerOutcomePath();
    if (!existsSync(path)) return;
    lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  } catch {
    return; // unreadable side channel: the rows keep their arrival shape
  }
  if (lines.length === 0) return;
  const rowIndexOf = new Map<string, number>();
  const rowSeqIndexOf = new Map<string, number>();
  const bound = Math.min(storeRowCount, out.length);
  for (let i = 0; i < bound; i += 1) {
    const event = out[i]!;
    const triple = `${event.sessionId}\0${event.tool}\0${event.argsHash}\0${event.grantedAt}`;
    rowIndexOf.set(triple, i);
    rowSeqIndexOf.set(`${triple}\0${event.arrivalSeq}`, i);
  }
  for (const line of lines) {
    const parsed = parseSpoolLine(line);
    if (parsed === undefined) continue;
    const record = parsed.parsed;
    if (!record || typeof record !== 'object') continue;
    const row = record as Partial<OutcomeLine>;
    if (
      typeof row.sessionId !== 'string' ||
      typeof row.tool !== 'string' ||
      typeof row.argsHash !== 'string' ||
      typeof row.grantedAt !== 'number' ||
      (row.outcomeDetail !== 'delivered' && row.outcomeDetail !== 'uncertain' && row.outcomeDetail !== 'failed')
    ) {
      continue;
    }
    const triple = `${row.sessionId}\0${row.tool}\0${row.argsHash}\0${row.grantedAt}`;
    // A seq-bearing line binds to the exact row (round 14, finding 4):
    // immune to compaction reordering; the twin's seq differs.
    if (typeof row.arrivalSeq === 'number') {
      const index = rowSeqIndexOf.get(`${triple}\0${row.arrivalSeq}`);
      if (index !== undefined) out[index]!.outcomeDetail = row.outcomeDetail;
      continue;
    }
    // Legacy line (pre-seq): the key+stamp last-store-row rule.
    const index = rowIndexOf.get(triple);
    if (index !== undefined) out[index]!.outcomeDetail = row.outcomeDetail;
  }
}

// The delivery-outcome follow-up (round 10, finding 4, both seats' shape;
// PR-3a's memo datum): record what became of the call a consent
// authorized, on the consent row that arrival created. The gate records
// the ARRIVAL (recordAskModeConsent, which returns the stamp it wrote);
// the dispatch layer — the only place that ever sees the handler's return
// or throw — hands that stamp here with the delivery class. The ledger's
// subject is the CONSENT's lifecycle (arrival + what became of the call
// it authorized), never the handler's internal execution.
//
// Ownership is proven by the STAMP, never by absence (round 12, finding 2,
// both seats' shape): the annotate proceeds only when a granted row on
// the key with EXACTLY the arrival's stamp exists in the main store. An
// arrival whose append was silently dropped (lockedAppend's best-effort
// catch — ENOSPC/EIO/EACCES, the clamp shapes) leaves no row anywhere, so
// the stamp matches nothing and the annotate is a no-op: the earlier
// call's row on the same key keeps its own datum. An arrival that
// degraded to the spool or a taken sidecar fails the same test (its row
// is not store-resident), which also enforces the r10/r11 posture —
// degraded arrivals carry no delivery outcome — and the outside-store
// guard (round 11, finding 1) still skips when any granted row on the
// key outside the store carries a stamp at or beyond this arrival's
// (this call's arrival degraded, a newer arrival lives outside the
// store, or an equal-stamp ambiguity).
//
// Best-effort in every direction: lockless (it writes only the additive
// side channel, so there is nothing to serialize and no holder to
// depose), skip on any failure, never throw, and never write the main
// store — the annotate may skip, never erase. A skipped or dropped
// annotation leaves the row as the arrival wrote it; the memo treats an
// absent outcomeDetail as unknown. The recorded residual is the RACING
// same-key shape alone (concurrent arrivals interleaving between arrival
// and annotate — PR-3a's keyed join lands with the approvedVia carrier,
// the recorded G2 note), plus the same-millisecond ambiguity the
// last-row rule resolves deterministically but not provably.
export function annotateDispatchOutcome(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  arrivalStamp?: number;
  outcomeDetail: ConsentDeliveryOutcome;
}): void {
  try {
    if (typeof params.arrivalStamp !== 'number') return; // no stamp: never annotate
    const raw = readRawConsents();
    if (raw === undefined) return; // absent or unreadable store: nothing to annotate
    let arrivalPresent = false;
    // The LAST matching row's seq (round 14, finding 4): the same-ms tie
    // rule the fold uses — when two store rows share the arrival's stamp,
    // the newest one at that stamp is the row the dispatch's annotate
    // binds to, and the captured seq makes that binding survive any later
    // compaction reordering (a same-ms degraded twin compacted in BEHIND
    // the annotated row must never steal the line).
    let arrivalSeq: number | undefined;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (
        record.sessionId === params.sessionId &&
        record.tool === params.tool &&
        record.argsHash === params.argsHash &&
        record.outcome === 'granted' &&
        record.grantedAt === params.arrivalStamp
      ) {
        arrivalPresent = true;
        if (typeof record.arrivalSeq === 'number') arrivalSeq = record.arrivalSeq;
      }
    }
    if (!arrivalPresent) return; // dropped append or degraded arrival: no row is provably this dispatch's
    if (newestGrantedStampOutsideStore(params) >= params.arrivalStamp) return; // the r11 guard
    appendLineAdditively(
      ledgerOutcomePath(),
      JSON.stringify({
        sessionId: params.sessionId,
        tool: params.tool,
        argsHash: params.argsHash,
        grantedAt: params.arrivalStamp,
        ...(arrivalSeq !== undefined ? { arrivalSeq } : {}), // SEQ_UNKNOWN lines stay legacy-keyed
        outcomeDetail: params.outcomeDetail,
      }) + '\n',
    );
  } catch {
    // best-effort by contract: a recording failure never fails the call
  }
}
