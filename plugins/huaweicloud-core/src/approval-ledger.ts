// Ask-mode consent ledger: one JSON event per completed ask-mode approval
// arrival, appended to the devkit state tree. Token mode records nothing —
// its evidence is the custody-HMAC grant inside approvals.json (single use,
// tombstone, five-minute TTL, all unchanged).
//
// The evidence tier is written from day one: 'elicitation' for the
// server-raised form the approval gate sends inside the run call,
// 'posture' for the T3 chat round-trip's attested retry (the model reports
// the user's chat answer; posture trust, not mechanically verified), and
// 'terminal' for approve-CLI confirmations the plan face reports. A
// channel-verified ladder arrival (PR-1.5, evidenceFinal) records the
// channel that just answered instead of inheriting. A memo-reuse event
// (PR-3a) inherits the ORIGINAL event's tier and never upgrades it, so a
// posture-grade yes can
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
// PR-3a landed contract (round 10, G2, recorded here when PR-1 carried no
// code for it): the tier-safe scoped writer is recordAskModeConsent's
// scope parameter — 'once' for ordinary arrivals and memo reuses (the tier
// resolution below applies identically), 'session' for the S3 standing
// consent grant the elicitation form's "remember for this session" tick
// writes. No writer routes through appendConsentEvent without tier
// resolution. The gate's ask result is the structured approvedVia carrier
// (approval-gate.ts, threaded through tools.ts); the S1 memo's state is
// the gate's in-memory record, armed by the dispatch recorder from the
// computed delivery outcome.
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
// The degradation may cost latency; evidence survives it when the
// additive spool write lands — but the spool append is itself
// best-effort (its catch never fails the call), so on a failing state
// tree the event can be lost, the same contract as the locked write's
// internal best-effort catch.
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
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { devkitStateBase } from './lib/state-dir.ts';
import { withDepLock } from './dep/receipts.ts';
import type { ConsentDeliveryOutcome, ConsentEvent, ConsentEvidence } from './approval-types.ts';

function ledgerFilePath(): string {
  return join(devkitStateBase(), 'approval-consents.json');
}

// ============================================================================
// THE RESIDUAL LEDGER — every disclosed adversarial-shape residual, rounds
// 15-23, named in one place (the operator's known-boundary list; the round
// that disclosed each shape is named, and every entry below is a MEASURED,
// run-proven boundary — not a spec claim):
//
// 1. The >8MiB mid-gap in-flight memo residual (r19-r21): sidecars above
//    the whole-file anchor band keep TWO 1MiB window digests; a mid-file
//    insert OUTSIDE both windows, raced in-flight inside the hit path's
//    validation window by a max-rate local writer, evades bounded content
//    validation (measured 14-19/40 with the re-stat across rounds' runs,
//    37/40 without; the sub-8MiB whole-file band closes it
//    deterministically; the complete closure is a per-append full rescan —
//    the r17-F3 cost the memo exists to avoid).
// 2. The cap-degradation burst pairs (r15+): ask arrivals that cross
//    LEDGER_MAX_WAIT_MS (3s) degrade together and race the unlocked
//    read-derive-write window, colliding on a seq — the equal-seq pair
//    then falls to grantedAt with weakest-wins at the exact tie. The
//    24x50 barrier race lane reproduces it under burst (deltas ~3s, the
//    signature); the production face (8x30) stays duplicate-free. The
//    keyed join that closes it lands with PR-3a.
// 3. The mid-scan out-of-band .taken-* writer (r17 O1b): a sidecar created
//    between the floor scan's readdir and the take can duplicate a seq on
//    the locked path — no LEGAL producer exists (takeSpool runs inside
//    the same lock hold), so it is recorded, not fixed; the degraded
//    readdir-vs-take interleave is a sub-shape of entry 2's unlocked race.
// 4. The compaction-crash duplicate (r7): a crash between the main write
//    and the taken-file removal leaves a taken file whose lines are
//    ALREADY in the store; the next compaction folds it again — the
//    duplicate is additive (a repeated consent row), the documented safe
//    direction.
// 5. The >V8-string taken file (r7): a sidecar past the whole-read limit
//    never folds through the line path; kept with its bytes intact,
//    retried every compaction, over the caps it blinds in O(1). There is
//    NO in-band recovery that restores the merged view: by construction a
//    spool past the read cap folds into a store past the SAME cap (a
//    568.8MB spool split into two readable chunks folds to a 568.8MB
//    store — over the cap, back to quarantine). The honest operator paths
//    are external: (a) archive the oversized taken file elsewhere and
//    accept that its rows leave the merged view, or (b) keep the store
//    under the cap by periodic maintenance before the spool accumulates
//    past it. The consequences, named exactly: the bytes are ALWAYS
//    preserved on disk (the taken file and the quarantine sidecar both
//    keep them); the view loss is permanent for that content (no code
//    path reads a .corrupt-* sidecar); and the counter reseeds from the
//    surviving rows. Under the caps the file is evidence, never a floor
//    source.
// 6. The fold's all-or-nothing element bound (r21-r23): a taken file
//    carrying ANY over-bound line keeps the WHOLE file — clean rows defer
//    with the poison (retried every compaction, never dropped) so a giant
//    preserved line can never be written into the store (the kill-switch
//    shape). The honest cost: a mixed file stays until the operator
//    splits it.
// 7. The multibyte admitted band (r23): the element guard scores UTF-8
//    BYTES — ASCII behavior is identical (bytes == units), but a
//    multibyte store previously admitted by unit count now quarantines
//    with its bytes (a 125Mi-unit CJK row is 375Mi of bytes, over the
//    256MiB bound — it previously ANSWERED at the edge of the measured
//    130Mi-unit abort cliff). The invariant the guard enforces: any
//    store it ADMITS is writable without abort, whatever its encoding;
//    the guard's byte walk adds to the admitted giant store's disclosed
//    multi-second tri-copy cost.
// 8. The r3-caller cost residuals (carried): the 250MiB-admitted
//    element's append keeps its multi-second tri-copy shape (unchanged
//    admitted behavior); the ~2.4s floor+resolution cost at 1M rows is
//    the tier resolution's inherent O(store) RMW.
// 9. The auth pack's status:'cleared' (r17 O5): classifies failed
//    through the delivery recorder — unregistered in PR-1; the PR-3b
//    registration round adds it to the success vocabulary.
//
// Every other adversarial surface measured across rounds 15-23 is CLOSED
// with an in-repo pin: the FIFO/device/sparse seams (r18-r20, bounded in
// ms), the O(size) reads (r20-r21, capped in O(1)), the SIGABRT shapes
// (r21-r23: the giant-value/key/exact-bound/multibyte element stores all
// quarantine with bytes preserved), the writeAll partial-count classes
// (r21-r22, byte-offset resume, byte-identity pinned), the memo key/
// anchor/tax regressions (r18-r21, each pinned with a mutation), the
// dead-span detector (r19-r20, byte-level, precise, blind memoized), the
// negation/polarity vocabulary (r16, the absence-phrase strip), the
// scanner carry (r18-r19: needle-in-carry extracts at any gap, the
// needle-lost span blinds), and the seq space (r15-r17: bounded,
// saturation a state, the file never a decision-maker).
// ============================================================================

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
// rounds 14-15): the last sequence number assigned, a few bytes beside the
// store. The counter is CLOCK-INDEPENDENT by construction — grantedAt can
// step backward under an NTP correction or a VM restore, and the
// (arrivalSeq, grantedAt) chronology key must still name the true
// original.
//
// Round 15, finding 1 (both seats) bounded the space: the r14 floor fix
// validated only the TYPE of the values it consumed, so one corrupted or
// adversarial row/file value near 2^53 poisoned the counter permanently —
// a determinable row landed ON the sentinel (mis-marked chronology-UNKNOWN
// forever), following rows left the safe-integer range, LOCKED writers
// duplicated seqs (the r14 zero-duplicates invariant falsified at a
// poisoned floor), and the grantedAt fallback re-opened the r13 fabricated
// upgrade end-to-end; an Infinity row serialized arrivalSeq:null and the
// consent vanished from every reader. The assignable space is bounded
// (below the exclusive SEQ_CEILING); any row or file value outside it is
// UNREADABLE — a row normalizes to the sentinel at read (visible, sorts
// newest, never invisible, never an original: unknown chronology cannot
// name one), the counter seeds from the max of VALID seqs only, and the
// ceiling band is never assignable. Round 16, finding 1 (both seats)
// closed the top edge the r15 clamp left: the boundary value itself
// floored every later append at the top and the clamp re-issued it —
// saturation is now a STATE (nextSeqFromFloor): no room left means the
// row is marked chronology-UNKNOWN, never a duplicate of an existing
// row's seq, and the file stays at the last assignable value.
//
// Round 15, finding 4 (both seats) made the floor CHEAP: the r14 fix ran
// the full merged-view scan on EVERY append (the file "optimization"
// consulted nothing), doubling the ask-arrival stall — at 1M rows a single
// append was 4.9-10.9s (past the 3s cap, so concurrent arrivals degraded
// and their unlocked seq assignments collided). The locked path now
// derives its floor from data it ALREADY parses (lockedAppend's store read
// and takeSpool's fold) plus the streamed .taken-* scan (rounds 16-17)
// and this process's last assignment: no extra IO, no merged-view read.
// The seq FILE is no longer a floor source at all (round 17, finding 1):
// the crash-gap values it used to cover are owned by no row (the row
// either landed in the spool/store the next section parses, or was lost
// entirely), so re-using them is safe, and no file value can decide the
// counter. The merged-view scan survives as the DEGRADED path's floor
// (round 16, finding 3), which the degraded path pays unconditionally.
//
// The assignment runs INSIDE the ledger lock's hold (round 14, finding 2):
// locked writers serialize for real (24 barrier workers, zero duplicates).
// The degraded path remains the recorded duplicate residual: it cannot
// hold the lock, its file read-write races, and equal seqs fall to
// grantedAt with weakest-wins governing the exact tie.
function ledgerSeqPath(): string {
  return join(devkitStateBase(), 'approval-consents.seq');
}

// The unknown-seq sentinel: sorts AFTER every real seq, so a row the
// counter could not number is never mistaken for the earliest arrival —
// and (rounds 15-16) never an original: the tier resolution skips sentinel
// rows, because unknown chronology cannot name one.
const SEQ_UNKNOWN = Number.MAX_SAFE_INTEGER;

// The EXCLUSIVE ceiling of the assignable space: integers in [0, SEQ_CEILING)
// are assignable — SEQ_CEILING itself and the one value below it
// (SEQ_UNKNOWN-1) are outside the space, never assigned, and never read as a
// row's seq. SEQ_UNKNOWN — the sentinel — IS assigned, as a STATE MARKER:
// saturation, blinded sources, and undeterminable chronology stamp rows with
// it, and every reader reads it back as exactly that (the sentinel sorts
// NEWEST, the tier resolution skips sentinel rows, and the annotate never
// binds a sentinel identity).
// Round 15 bounded the space with two values of headroom; round 16, finding 1
// (both seats) found the boundary itself was the poison: a value at the old
// ceiling floored every later append at the top, and clampNextSeq re-issued
// it — the same value an existing row owned — forever, on both paths, with
// no repair (four appends, one seq; the r14 zero-duplicate invariant
// falsified; and the grantedAt fallback re-opened the r13 fabricated
// upgrade). Saturation is now a STATE, not a value: when the floor leaves
// no assignable value above it, new rows take the SENTINEL (chronology
// unknown, sorts newest, never an original), the ceiling band reads as the
// sentinel at the raw-store guard and the filtered view alike, and the seq
// file stays at the last assignable value (the brief's "left at the
// ceiling" form: the append path checks saturation explicitly and never
// re-issues). A row or file staged INSIDE the ceiling band is unreadable —
// the counter repairs the file from the parsed floor and never floors on
// the row, so a saturated tree is sticky by construction and a corrupted
// one recovers monotonically.
const SEQ_CEILING = Number.MAX_SAFE_INTEGER - 2;

// A seq is readable iff it is an integer inside the assignable space
// (below the exclusive ceiling; safe by construction).
function isValidArrivalSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < SEQ_CEILING;
}

// The next assignable seq from a known floor — or the sentinel when the
// space is exhausted (round 16, finding 1: "no room left" is never
// "re-issue the top"; a new arrival must never duplicate an existing
// row's seq, so an unassignable increment marks the row chronology-UNKNOWN
// instead of guessing).
function nextSeqFromFloor(floor: number): number {
  return floor + 1 < SEQ_CEILING ? floor + 1 : SEQ_UNKNOWN;
}

// The highest valid seq among parsed store/spool entries — the locked
// path's floor, computed from data the caller already parsed (no IO).
// Out-of-range and absent values are invisible to the floor by design.
function maxValidSeqAmong(entries: unknown[]): number {
  let max = -1;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const seq = (entry as Record<string, unknown>).arrivalSeq;
    if (isValidArrivalSeq(seq) && seq > max) max = seq;
  }
  return max;
}

// The merged view's highest valid seq — the degraded path's repair leg
// (the file is invalid and no parsed data exists). Read-only; sentinel
// rows are skipped (they are not seqs the counter can build on).
function maxArrivalSeqInStore(): number {
  let max = -1;
  for (const event of readConsentEvents()) {
    if (event.arrivalSeq !== SEQ_UNKNOWN && event.arrivalSeq > max) max = event.arrivalSeq;
  }
  return max;
}

// The seq file's value was REMOVED from every floor in round 17, finding 1
// (both seats' band work): the r16 "sticky saturation" rule trusted the
// file's value to decide that the space was exhausted, so ONE corrupted
// byte at the last valid value (MAX_SAFE-3 — in-range, indistinguishable
// from genuine saturation, which needs ~9e15 appends to reach) permanently
// marked every later consent chronology-UNKNOWN with no repair: the file
// was written back unchanged, the delivery annotation could never bind
// again (a healthy store records delivered), and the tier inheritance
// mis-graded DOWN forever (a terminal original re-recorded posture, the
// never-upgrade line broken by the counter's own state). The floor is now
// ALWAYS the parsed max — the store rows, the taken/spool entries, the
// sidecar/spool scans — plus this process's last assignment; the FILE IS
// AN OPTIMIZATION, NEVER A DECISION-MAKER (the r15 doctrine, now enforced):
// it is written with the current truth on every append and read by no code
// path (operators may inspect it). "Saturation" means exactly "the parsed
// max has no room above it": a row legitimately at the last assignable
// value still saturates (in-space seqs are trusted by design — the r15/r16
// doctrine), but no FILE value can fabricate the state, and pruning the
// store below the ceiling releases the counter naturally.
let lastAssignedSeq: number | undefined;

// Write the high-water back — the current truth (the last assignable value
// assigned, or the parsed floor when this append marked unknown), best-effort
// (a failed write never fails the append — the file decides nothing).
function writeSeqFileMonotonic(next: number): void {
  if (next < 0) return; // nothing assignable has ever been seen: leave the file absent
  try {
    const path = ledgerSeqPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.seq.tmp`;
    writeFileSync(tmp, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best-effort: the parsed floor recovers on the next append
  }
}

// The streaming seq-field scanner (round 17, findings 2 and 3): reads a
// spool/sidecar file's arrivalSeq values in chunks WITHOUT building a
// whole-file string — a file past V8's string limit (~512MB) makes every
// readFileSync(file, 'utf8') throw ERR_STRING_TOO_LONG AFTER reading all
// its bytes, the round-7 PERMANENT fold-failure class, which the r16 scan
// re-paid on every append (~1.4-1.5s per 588MB sidecar; three crossed the
// 3s wait cap and every concurrent arrival degraded). The scan finds the
// `"arrivalSeq"` key bytes and reads the numeric literal that follows —
// spoof-proof by JSON's own escaping rules: inside a string value a quote
// is ALWAYS written `\"`, so the unescaped byte sequence `"arrivalSeq"`
// can only be a real object key in valid JSON; a hand-staged invalid line
// that matches can only push the floor HIGHER (a false max creates a gap,
// never a duplicate — the safe direction), and its rows are invisible to
// every reader forever (the malformed-line tolerance), so no visible row
// can own a seq the scan missed. A file that cannot be OPENED or READ is
// a BLINDED source (the r16 doctrine): its rows are committed and own
// unknowable seqs, so the caller must mark the arrival chronology-unknown
// rather than risk a duplicate.
const SEQ_SCAN_CHUNK_BYTES = 1 << 20;
// Round 18, finding 2 (A1; A2's O1) set the carry at 320 bytes; round 19,
// finding 3 (both seats) falsified the miss claim that accompanied it.
// The extraction geometry: a needle whose number lies past the chunk end
// is carried whole into the next haystack iff its start is within the
// last CARRY bytes — so a needle at ≥ (boundary - CARRY) extracts across
// the boundary at ANY gap width (the carry+chunk concatenation makes the
// span contiguous; measured: 4000-5000-space gaps extract), and the
// boundary of the whole story is the NEEDLE's distance from the edge
// (320/321), not the gap. What the r18 comment got WRONG: it called a
// needle lost past the carry "a documented miss ... a gap, never a
// duplicate" — both directions falsified: a lost-needle row's seq is
// invisible to every floor source (the file is past the whole-read limit,
// so the fold cannot read it either), and the next append assigns the
// missed row's committed seq (A2: a 501MiB sidecar at the DEFAULT limit,
// assignments [6,7,8,9] with the missed row owning 9; after the operator
// split the equal-seq pair falls to grantedAt and the reuse inherited
// terminal — the fabricated upgrade); the truncated-prefix shape was
// worse: the prefix floors at-or-below only for the NEXT assignment, and
// the counter MARCHES INTO the row's committed seq a few appends later
// (A1: six appends walked [301..306] into the row's 305). The r19 fix
// is the dead-span detector in streamMaxValidSeq: a pass that ends
// inside an open-or-truncated needle-to-literal span whose needle falls
// outside the carry marks the source BLINDED — the chronology-unknown
// doctrine, the sentinel — never a silent miss. The extractor's reach
// stays: gaps of ANY width extract while the needle is within the
// carry; the detector governs only the needle-lost shapes.
const SEQ_SCAN_CARRY_BYTES = 320;

// The streamed scan's shape (rounds 19-20): the max plus the CONTENT
// ANCHORS the memo validates. Round 19 anchored on headSeq/tailSeq — the
// first/last seq VALUES in the end windows — and both r20 seats falsified
// that (complementary shapes): the anchors are two scalars, so a middle
// in-place insert preserving the first/last rows' seqs collides them
// (A1: a 1200-byte 3-row sidecar, only the middle row rewritten, 7/40 +
// the full harm chain; A2: a hit-path TOCTOU needing no tick race at all
// — the hit path stats ONCE, and the attacker's write lands after it —
// 15-19/40 at the production default limit). Round 20 anchors on BYTES
// and a COUNT, both derived from the SAME windows on both paths (F4's
// reader disagreement — the r19 scan's tailSeq persisted across passes
// while the anchor reader's tail window stopped at 1MiB+320, so an
// unchanged file never memoized — dissolves when both paths read the
// same windows): headDigest/tailDigest are sha256 digests of the head
// window [0, min(size,CHUNK)) and the tail window [size-CHUNK-CARRY,
// size), and seqCount is the number of seq-field matches over BOTH
// windows (deterministically double-counting their overlap for small
// files — both paths compute it identically, which is what matters).
type StreamAnchors = {
  headDigest: string;
  tailDigest: string;
  seqCount: number;
};

// deadSpan: the blind came from the dead-span detector on a file the scan
// otherwise READ TO EOF (content-stable — memoizable, unlike an
// open/read/cap failure whose recovery must rescan); a memoized entry
// reproduces the blinded verdict on a validated hit instead of re-paying
// the per-append rescan tax (round 20, finding 3).
type StreamSeqScan = {
  max: number;
  blinded: boolean;
  deadSpan: boolean;
  anchors: StreamAnchors | undefined;
};

function streamMaxValidSeq(path: string): StreamSeqScan {
  let fd: number | undefined;
  try {
    // Rounds 18-19, findings 3/1/4: the scan's only failure class was
    // THROWN errors — a FIFO entry with the reserved .taken-* name BLOCKED
    // the open, a symlink to /dev/zero never reached EOF, and a rename
    // landing between the r18 stat and the open wedged the append inside
    // the ledger lock's hold (the heartbeat kept the claim fresh, so
    // takeover never fired). The open is atomic-by-construction now:
    // O_NONBLOCK (a no-op on regular files) + the FD's own fstat — a
    // non-regular entry is a BLINDED source, never read, whatever the
    // path held at any instant.
    fd = openRegularForRead(path);
    if (fd === undefined) return { max: -1, blinded: true, deadSpan: false, anchors: undefined };
    // Round 20, finding 1: the DECLARED size caps the stream — a sparse
    // entry (one truncate, ~8KiB of disk, any size) would otherwise buy
    // hours of CPU-bound chunk scanning inside the lock hold; over-cap
    // blinds in O(1) (the over-limit posture, the store's own definition).
    if (fstatSync(fd).size > streamScanLimitBytes()) {
      return { max: -1, blinded: true, deadSpan: false, anchors: undefined };
    }
    const chunk = Buffer.alloc(SEQ_SCAN_CHUNK_BYTES);
    // A number cut by a chunk boundary matches TRUNCATED in this pass and
    // whole in the next when the NEEDLE is carried (the carry re-presents
    // it): truncation only drops trailing digits, so the truncated value
    // is never ABOVE the real one, and the full value follows — the max
    // converges. A number ending at EOF is matched by its own final
    // chunk's pass, terminator or not.
    const seqFieldRe = /"arrivalSeq"\s*:\s*(-?[\d.eE+]+)/g;
    // Round 19, finding 3 (both seats): the dead-span detector. A pass
    // whose text ENDS inside a needle-to-literal span is the shape the
    // r18 comment called "a gap, never a duplicate" — falsified: when the
    // NEEDLE also falls outside the carry window, the span can never
    // complete in a later pass (the next haystack starts mid-gap with no
    // needle), the row's real seq is invisible to every floor source, and
    // the next append assigned the missed row's committed seq — the
    // duplicate direction (A2: a 501MiB sidecar, [6,7,8,9] with the
    // missed row owning 9; A1: the truncated-prefix shape let the counter
    // MARCH INTO the row's seq across six appends; both ran to the
    // fabricated-upgrade chain). The detector: the text ends with an
    // open-or-partial needle-to-number span (the regex allows an empty or
    // truncated literal at the very end) AND the span's needle starts
    // before the carry window (it will not be carried) — a DEAD span. The
    // safe posture the doctrine already uses for a blinded file: mark the
    // source BLINDED (chronology-unknown, the sentinel), never a silent
    // miss. A needle INSIDE the carry completes next pass and never trips
    // the detector (the r18 extraction pin); at true EOF an open span is
    // a torn tail — an UNCOMMITTED row (the r17 doctrine, its gap
    // semantics measured safe) — so the flag is cleared when the next
    // read returns empty. The needle position compares in BYTES (the carry
    // window is bytes; a multibyte tail would otherwise skew the boundary).
    // The colon is OPTIONAL: a span whose colon lies past the chunk boundary
    // ends the pass as needle+whitespace with no colon yet — the same dead
    // shape (the needle outside the carry can never be re-presented).
    // Round 20: the detector is BYTE-LEVEL and PRECISE. The r19 form
    // computed a UTF-16 character index and re-encoded it to "bytes" —
    // under the lossy utf8 decode each invalid byte became U+FFFD and
    // inflated the computed offset by 2 bytes, shrinking the blind band:
    // one invalid byte (or a multibyte char) before the needle turned
    // the 320/321 boundary into a silent miss (seat 2's skew). The
    // needle's byte offset is taken from the BUFFER directly (exact), and
    // the span is open iff every byte after the needle to the buffer end
    // is in the span alphabet (whitespace, ':', digits, . e E + -). The
    // verdict stays PER BOUNDARY, held PENDING until the next read proves
    // a following chunk exists (the EOF read discards it: a torn tail at
    // true EOF is an uncommitted row, the r17 doctrine) — and round 20,
    // finding 3 resolved it with a ONE-BYTE LOOKAHEAD at the next chunk's
    // first byte, so a literal completing EXACTLY at the boundary (the
    // r19 false positive: the value fully extracted, yet blinded — a
    // permanent per-append rescan at ~1s/200MB) is recognized and NOT
    // dead: digit/.eE+- continues the literal (or starts it): dead;
    // whitespace completes a number whose digits were all seen (JSON
    // puts no space inside a number) but keeps a digit-less span
    // pre-number: dead; ':' keeps it pre-number: dead; anything else
    // means the literal completed or no number is coming: not dead.
    const needleBuf = Buffer.from('"arrivalSeq"', 'utf8');
    const isWsByte = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
    const isLiteralByte = (b: number): boolean =>
      (b >= 0x30 && b <= 0x39) || b === 0x2e || b === 0x65 || b === 0x45 || b === 0x2b || b === 0x2d;
    const isSpanByte = (b: number): boolean => isWsByte(b) || b === 0x3a || isLiteralByte(b);
    const isDigitByte = (b: number): boolean => b >= 0x30 && b <= 0x39;
    let carry = Buffer.alloc(0);
    let max = -1;
    let deadAccum = false;
    // The PREVIOUS pass's pending open span (null = none): resolved by
    // this pass's first byte per the lookahead above.
    let prevOpen: { hasDigits: boolean } | null = null;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break; // the pending verdict was the EOF boundary's: discard it (torn tail)
      const data = chunk.subarray(0, read);
      const haystack = carry.length > 0 ? Buffer.concat([carry, data]) : data;
      const text = haystack.toString('utf8');
      let match: RegExpExecArray | null;
      while ((match = seqFieldRe.exec(text)) !== null) {
        const value = Number(match[1]!);
        if (isValidArrivalSeq(value) && value > max) max = value;
      }
      if (prevOpen !== null) {
        const b = data[0]!;
        if (isLiteralByte(b) || b === 0x3a || (isWsByte(b) && !prevOpen.hasDigits)) deadAccum = true;
        prevOpen = null;
      }
      const needleAt = haystack.lastIndexOf(needleBuf);
      if (needleAt !== -1) {
        let pure = true;
        let hasDigits = false;
        for (let j = needleAt + needleBuf.length; j < haystack.length; j += 1) {
          const b = haystack[j]!;
          if (isDigitByte(b)) hasDigits = true;
          if (!isSpanByte(b)) {
            pure = false;
            break;
          }
        }
        if (pure && needleAt < haystack.length - SEQ_SCAN_CARRY_BYTES) prevOpen = { hasDigits };
      }
      const keep = Math.min(SEQ_SCAN_CARRY_BYTES, haystack.length);
      carry = Buffer.from(haystack.subarray(haystack.length - keep)); // copy: the chunk is reused
    }
    // The anchors come from the SAME windows the hit path reads (round 20,
    // F4): derived after the pass via positioned reads on this fd — the
    // r19 tailSeq (persisted across passes, the file's LAST seq anywhere)
    // disagreed with the reader's window and an unchanged wide-tail file
    // never memoized.
    const anchors = anchorDataFromFd(fd, fstatSync(fd).size);
    if (deadAccum) return { max: -1, blinded: true, deadSpan: true, anchors };
    return { max, blinded: false, deadSpan: false, anchors };
  } catch {
    return { max: -1, blinded: true, deadSpan: false, anchors: undefined }; // unreadable: unknown owners
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort: a leaked descriptor is the least harm here
      }
    }
  }
}

// Read the anchor windows off an OPEN fd and derive the content anchors
// (round 20, findings 2 and 4): the head window [0, min(size,CHUNK)) and
// the tail window [size-CHUNK-CARRY, size), the SAME windows both the scan
// and the hit path derive their anchors from (F4: the r19 pair used
// different definitions — the scan's tailSeq persisted across passes, the
// reader's window stopped at 1MiB+320 — so an unchanged file whose last
// seq sat farther from EOF never memoized: a permanent per-append rescan).
// Two positioned reads, O(window); sha256 digests + the seq-field match
// count over the windows. The count is the brief's third gate: a middle
// INSERT inside a covered window changes the count even where a digest
// comparison alone might be argued away — and for files ≤ CHUNK+CARRY the
// windows cover the whole file, so ANY byte change anywhere (the r20 A1
// 1200-byte escape, the r20 A2 middle insert on small sidecars) changes
// a digest or the count.
const SEQ_FIELD_COUNT_RE = () => /"arrivalSeq"\s*:\s*(-?[\d.eE+]+)/g;

// Small files get WHOLE-FILE anchors (round 20, the sub-tick closure):
// windowed digests cannot see an insert between the windows, and the
// re-stat's coarse-clock granularity (~1ms kernel ticks) lets a write
// completing inside the cached-fast anchor reads pass — measured 4/40
// wins on a 5MiB file with the re-stat alone. For files ≤ 8MiB the
// anchor read covers the WHOLE file, so ANY byte change anywhere changes
// the digest deterministically, whatever the clock did. Round 21,
// finding 3 corrected the r20 cost claim ("a cached ~2ms read — inside
// the single-digit-ms cost bar" — measured ~62ms median per append at
// the 8MiB top edge, ~31ms at 4MiB, ~15ms at 2MiB, ~11x the r19 windowed
// hit at the same size) and cut the redundancy: the whole-file digest
// subsumes the seq-count gate inside the band, so the count pass (the
// full-text decode plus the regex sweep — half the measured hit cost)
// is SKIPPED for whole-file-anchored sizes and seqCount is recorded as 0
// on both paths (identically, so the memo comparison stays consistent).
// The honest measured cost of the remaining read+sha256 hit path:
// ~7-15ms at the realistic sizes (≤4MiB), ~30ms at the 8MiB top edge —
// documented in the round's record, still inside the r3 caller bar by
// two orders of magnitude. Larger files keep the two 1MiB windows; their
// residual — a same-tick insert landing in the uncovered middle of a
// >8MiB file — is the r19-disclosed class with the corrected size
// boundary.
const ANCHOR_WHOLE_FILE_BYTES = 8 * 1024 * 1024;

function anchorDataFromFd(fd: number, size: number): StreamAnchors {
  if (size <= ANCHOR_WHOLE_FILE_BYTES) {
    const wholeBuf = Buffer.allocUnsafe(size);
    const got = readSync(fd, wholeBuf, 0, size, 0);
    const digest = createHash('sha256').update(wholeBuf.subarray(0, got)).digest('base64');
    return { headDigest: digest, tailDigest: digest, seqCount: 0 }; // the count gate is subsumed: skipped in the band
  }
  const headLen = Math.min(size, SEQ_SCAN_CHUNK_BYTES);
  const headBuf = Buffer.allocUnsafe(headLen);
  const headGot = readSync(fd, headBuf, 0, headLen, 0);
  const headText = headBuf.toString('utf8', 0, headGot);
  const tailLen = Math.min(size, SEQ_SCAN_CHUNK_BYTES + SEQ_SCAN_CARRY_BYTES);
  const tailBuf = Buffer.allocUnsafe(tailLen);
  const tailGot = readSync(fd, tailBuf, 0, tailLen, Math.max(0, size - tailLen));
  const tailText = tailBuf.toString('utf8', 0, tailGot);
  let seqCount = 0;
  const countRe = SEQ_FIELD_COUNT_RE();
  while (countRe.exec(headText) !== null) seqCount += 1;
  const countRe2 = SEQ_FIELD_COUNT_RE();
  while (countRe2.exec(tailText) !== null) seqCount += 1;
  return {
    headDigest: createHash('sha256').update(headBuf.subarray(0, headGot)).digest('base64'),
    tailDigest: createHash('sha256').update(tailBuf.subarray(0, tailGot)).digest('base64'),
    seqCount,
  };
}

// The hit path's anchor read (round 20, finding 2): opens its own guarded
// fd, applies the stream cap, derives the anchors from the same windows.
// An anchor read that fails (absent, non-regular, over-cap now) returns
// undefined and forces the full rescan.
function readAnchorData(path: string): StreamAnchors | undefined {
  const fd = openRegularForRead(path);
  if (fd === undefined) return undefined;
  try {
    const size = fstatSync(fd).size;
    if (size > streamScanLimitBytes()) return undefined; // over-cap: never trusted
    if (size === 0) return undefined; // an empty file has no anchors: rescan (it blinded anyway)
    return anchorDataFromFd(fd, size);
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
}

// The sidecar scan memo (round 17, finding 3; key discipline rounds 18-19):
// a successful scan's result is memoized so the SECOND append pays
// nothing. The key is ENFORCED, not assumed — twice falsified now: r18
// keyed by path+mtime+size on the "append-only-immutable once taken"
// claim, and both seats falsified it with the operator-remediation class
// (a timestamp-preserving replacement collided all three fields); the r18
// fix added dev+ino+ctimeMs on the "userland cannot forge ctime" claim —
// and r19 (A1) falsified THAT against the kernel's COARSE clock (~1ms
// ticks): a touch loop holds the sidecar's ctime at the current tick
// through append1's scan, the rewrite fires in the SAME tick, all five
// fields collide, and the stale memo re-issued the replacement's
// committed seq — the full r18 harm chain, 14/100 on tmpfs (ext4 0/400,
// the filesystem-latency dependence the unconditional claim hid). The
// hit is now CONTENT-VALIDATED, not metadata-validated: the memo stores
// the CONTENT ANCHORS the scan itself extracted — headSeq/tailSeq, the
// first and last seq values in the scan's first and final haystack
// windows — and every hit re-reads those two windows (two positioned
// reads, O(1) at the 588MB scale) and compares: any mismatch rescans.
// The anchors describe the bytes the memoized max was computed FROM, so
// a replaced file shows different anchors whatever the metadata clock
// did — the same-tick forge's replacement changes the whole file, both
// windows included. The metadata fields stay as a cheap first gate (a
// post-decision replacement still rescans at the stat without paying the
// anchor reads); the read-validate (stat before and after the scan)
// stays as the in-flight guard on the WRITE side. What remains outside
// the anchors, disclosed honestly: a rewrite confined to the MIDDLE of a
// >2MB sidecar that preserves both end windows byte-for-byte — bounded
// content validation cannot see middle bytes, and the complete closure
// is a per-append full rescan (the exact r17 finding-3 cost the memo
// exists to avoid). Failures are NEVER memoized: a chmod-blocked file's
// recovery (the r16 pin) must rescan.
const takenSeqScanMemo = new Map<
  string,
  {
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    max: number;
    blinded: boolean; // round 20 F3: a memoized dead-span blind reproduces itself on a validated hit
    headDigest: string;
    tailDigest: string;
    seqCount: number;
  }
>();

// The .taken-* sidecar seq scan (round 16, finding 2, both seats; streamed
// and memoized round 17, finding 3): the reader folds every .taken-* file's
// rows, so the floor must consult them too — a committed sidecar row whose
// fold fails this cycle (round 7 finding 3's documented transient class,
// kept on disk for the mandated retry) was invisible to every r15 floor
// source, so the next append re-issued its seq and the mandated read
// recovery exposed a duplicate pair whose chronology fell back to grantedAt
// — the clock dependence the counter was built to remove, driven organically
// cross-process by both seats. The scan streams SEQ FIELDS ONLY (chunked
// bytes, no whole-file string) and is SUPERSET-honest: a sidecar that
// cannot be READ — or is not a regular file at all (round 18, finding 3:
// a FIFO or device entry with the reserved name would BLOCK the open
// inside the ledger lock's hold, cross-process, so a non-regular entry is
// a blinded source, never opened) — is a BLINDED source: its rows are
// committed and own seqs we cannot see, so the space above the known max
// is not provably free and the append takes the sentinel rather than risk
// a duplicate. When the read recovers the counter continues from the
// sidecar's real seqs.
// `skipFiles` are the files THIS section's takeSpool already folded
// successfully (their parsed events are in the floor already) — scanning
// them again would re-read bytes the section already parsed.
function scanTakenSidecarSeqs(skipFiles: string[] = []): { max: number; blinded: boolean } {
  let max = -1;
  let blinded = false;
  for (const file of takenSpoolFiles()) {
    if (skipFiles.includes(file)) continue; // folded this section: parsed events already floor us
    let statBefore: ReturnType<typeof statSync> | undefined;
    let memoized = false;
    try {
      statBefore = statSync(file);
      const memo = takenSeqScanMemo.get(file);
      if (
        memo !== undefined &&
        memo.mtimeMs === statBefore.mtimeMs &&
        memo.ctimeMs === statBefore.ctimeMs &&
        memo.size === statBefore.size &&
        memo.dev === statBefore.dev &&
        memo.ino === statBefore.ino
      ) {
        // Rounds 19-20, findings 2: the metadata fields can all collide
        // (the same-tick in-flight rewrite — the kernel's coarse ctime
        // clock; or a write landing after this stat, which the r19 hit
        // path never saw because it statted ONCE), so the hit is decided
        // by CONTENT, re-validated exactly like the scan path: read the
        // anchor windows (the same windows the scan derives its anchors
        // from — BYTES, digests, and the window seq count — not the r19
        // seq VALUES a middle insert preserving the end rows collided),
        // then RE-STAT: any write that moved the file between the two
        // stats fails the hit and takes the full rescan. The residual
        // window is the microseconds between the re-stat and the
        // assignment — the scan path's own disclosed in-flight boundary,
        // now symmetric.
        const anchors = readAnchorData(file);
        let anchorsMatch = false;
        try {
          const statAfterHit = statSync(file);
          anchorsMatch =
            anchors !== undefined &&
            statAfterHit.mtimeMs === statBefore.mtimeMs &&
            statAfterHit.ctimeMs === statBefore.ctimeMs &&
            anchors.headDigest === memo.headDigest &&
            anchors.tailDigest === memo.tailDigest &&
            anchors.seqCount === memo.seqCount;
        } catch {
          anchorsMatch = false; // unstatable now: rescan
        }
        if (anchorsMatch) {
          // Round 21, finding 1 (seat 1): a validated hit memoizes
          // UNCONDITIONALLY — the r20 restructure made memoized conditional
          // on the max improving the running floor, so in a multi-sidecar
          // state a sidecar whose memoized max did not exceed an earlier
          // sidecar's contribution fell through to a FULL RESCAN on every
          // append forever (measured 344-593ms per 64MiB non-improving
          // sidecar vs 37/28/30ms for the swapped control on identical
          // content; the r19 source memoized on the same tree) — the exact
          // permanent-rescan tax class r17-F3/r20-F3/F4 were each accepted
          // as findings for, reintroduced by the fix that closed them.
          // The improvement check stays as a max-compare only.
          if (memo.blinded) {
            blinded = true; // a stable dead-span blind: the verdict reproduces, no rescan (round 20 F3)
            memoized = true;
          } else {
            if (memo.max > max) max = memo.max;
            memoized = true;
          }
        }
      }
    } catch {
      // the stat failed: fall through to the stream (which will blind)
    }
    if (memoized) continue;
    const scanned = streamMaxValidSeq(file);
    if (scanned.blinded && !scanned.deadSpan) {
      blinded = true; // committed rows behind an unreadable/over-cap/non-regular file: unknown owners
      continue; // never memoized: recovery (chmod, operator repair) must rescan (the r16 pin)
    }
    if (scanned.blinded) {
      // deadSpan: the file read fine, the content is the cause — a stable
      // blind. Memoize it (anchors validate the hit like any scan) so the
      // per-append rescan tax dies (round 20, finding 3: measured ~1s per
      // append at 200MB, forever, from a shape where the r19 detector
      // over-fired; the precise lookahead now extracts most of those, and
      // the genuinely-dead ones pay the scan ONCE).
      blinded = true;
    } else if (scanned.max > max) max = scanned.max;
    try {
      // READ-VALIDATE: the pre-scan and post-scan stats must agree, or the
      // bytes scanned are not the bytes the key describes — never memoize.
      const statAfter = statSync(file);
      if (
        statBefore !== undefined &&
        statAfter.mtimeMs === statBefore.mtimeMs &&
        statAfter.ctimeMs === statBefore.ctimeMs
      ) {
        if (scanned.anchors !== undefined) {
          takenSeqScanMemo.set(file, {
            dev: statAfter.dev,
            ino: statAfter.ino,
            mtimeMs: statAfter.mtimeMs,
            ctimeMs: statAfter.ctimeMs,
            size: statAfter.size,
            max: scanned.max,
            blinded: scanned.blinded,
            headDigest: scanned.anchors.headDigest,
            tailDigest: scanned.anchors.tailDigest,
            seqCount: scanned.anchors.seqCount,
          });
        }
      }
    } catch {
      // the memo is an optimization: an unstatable file rescans next time
    }
  }
  return { max, blinded };
}

// The ACTIVE spool's seq scan (round 17, finding 2): the degraded path
// cannot take the spool (no lock), and the merged view's spool read throws
// for the r7 permanent class (a spool past V8's string limit) — so the
// degraded floor was one source short of superset-consistency and re-issued
// committed spool rows' seqs (the locked twin blinds correctly through the
// taken scan after takeSpool's rename). The stream covers the spool the
// same way it covers sidecars; an unreadable spool is a BLINDED source.
function scanSpoolSeqs(): { max: number; blinded: boolean } {
  try {
    const spool = ledgerSpoolPath();
    if (!existsSync(spool)) return { max: -1, blinded: false };
    return streamMaxValidSeq(spool);
  } catch {
    return { max: -1, blinded: false }; // absent spool: nothing to floor from
  }
}

// Assign seqs to the events of a LOCKED append, floored by everything the
// section already parses (the store rows, the taken spool events) plus the
// .taken-* sidecar scan (round 16, finding 2; streamed and memoized round
// 17, findings 2-3) and this process's last assignment. Runs inside the
// ledger lock's hold — no merged-view read, no extra parse (round 15,
// finding 4). The seq FILE is not a floor source (round 17, finding 1): it
// is an optimization, never a decision-maker. Saturation and a blinded
// source both mark the row chronology-UNKNOWN (round 16, finding 1): on
// the locked path with validated sources the counter never re-issues a
// value an existing row owns; the mid-gap in-flight insert ABOVE the
// determinism band is the recorded exception (the RESIDUAL LEDGER's
// entry 1 — a racing local writer inside the memo hit's validation
// window, measured 14-19/40).
function assignSeqsLocked(
  events: ConsentEvent[],
  storeEntries: unknown[],
  spoolEntries: unknown[],
  folded: string[],
): void {
  const takenScan = scanTakenSidecarSeqs(folded);
  const floor = Math.max(
    maxValidSeqAmong(storeEntries),
    maxValidSeqAmong(spoolEntries),
    takenScan.max,
    lastAssignedSeq ?? -1,
  );
  let next = floor;
  for (const event of events) {
    next = takenScan.blinded ? SEQ_UNKNOWN : nextSeqFromFloor(next);
    event.arrivalSeq = next;
    if (next !== SEQ_UNKNOWN) lastAssignedSeq = next;
  }
  // The high-water file keeps the last ASSIGNABLE value (or the known floor
  // when this append marked unknown): a sentinel never reaches the file.
  writeSeqFileMonotonic(lastAssignedSeq !== undefined && lastAssignedSeq > floor ? lastAssignedSeq : floor);
}

// Assign a seq on the DEGRADED path (no lock, nothing parsed): the
// merged-view scan is UNCONDITIONAL (round 16, finding 3, both seats — the
// r15 cost fix had made the repair scan conditional on an INVALID seq
// file, so a VALID-but-rewound file short-circuited the only repair leg on
// the one path that has nothing parsed; the degraded path is the rare path,
// and the cost fix's purpose was the LOCKED common case). The .taken-*
// scan (round 16, finding 2) covers what the merged view cannot read, and
// the ACTIVE-SPOOL scan (round 17, finding 2) covers the one source the
// r16 fix missed — a spool past V8's string limit whose rows the merged
// view cannot read at all: the floor must see every source the reader can,
// and a blinded sidecar, a blinded spool, or saturation marks the row
// unknown, never a duplicate. The seq file is not a floor source here
// either (round 17, finding 1). The unlocked file read-write still races
// under concurrent degraded arrivals — the recorded duplicate residual.
function assignSeqDegraded(event: ConsentEvent): void {
  try {
    const takenScan = scanTakenSidecarSeqs();
    const spoolScan = scanSpoolSeqs();
    const floor = Math.max(maxArrivalSeqInStore(), takenScan.max, spoolScan.max, lastAssignedSeq ?? -1);
    const next = takenScan.blinded || spoolScan.blinded ? SEQ_UNKNOWN : nextSeqFromFloor(floor);
    event.arrivalSeq = next;
    if (next !== SEQ_UNKNOWN) lastAssignedSeq = next;
    writeSeqFileMonotonic(lastAssignedSeq !== undefined && lastAssignedSeq > floor ? lastAssignedSeq : floor);
  } catch {
    event.arrivalSeq = SEQ_UNKNOWN; // the store read itself failed: unknown
  }
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
// ledger is best-effort by contract, and an approved call never blocks
// unboundedly ON THE LOCK — the wait is capped and the waiter degrades
// past it. The cap does NOT bound the holder's own section, which is the
// uncapped O(store) read-modify-write (the recorded cost residual: 4.1s
// at 1.4M events, 23.5s at the exact 500MB cap edge) — an approved call
// on a giant tree is slow, never wedged — and dead holders (immediate
// reclaim) and empty stale dirs (1s) keep their current behavior under
// the cap. The cap applies to
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
      (record.evidence !== 'terminal' && record.evidence !== 'elicitation' && record.evidence !== 'posture')
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
      // Round 15, finding 1: a seq outside the assignable space (absent,
      // null, negative, fractional, Infinity, at/above the sentinel) reads
      // as the SENTINEL — the row stays VISIBLE, sorts newest, and can
      // never be an original — never invisible (the pre-fix Infinity row
      // serialized to null and vanished from every reader, losing consent
      // events to a one-field corruption).
      arrivalSeq: isValidArrivalSeq(record.arrivalSeq) ? record.arrivalSeq : SEQ_UNKNOWN,
    };
    // The command-forward line (redacted at write time): pass it through
    // when present and well-formed; a malformed value reads as absent —
    // the same tolerance the other optional fields carry.
    if (typeof record.command === 'string' && record.command !== '') {
      event.command = record.command;
    }
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
    // Round 19, finding 1: the main store read runs through the guarded
    // open — a FIFO parked at the store path wedged every arrival (the
    // tier resolution, the append, the real callTool face, cross-process).
    // A non-regular entry reads as absent-or-unreadable, the callers'
    // existing degraded postures (lockedAppend quarantines it — the
    // rename preserves the entry's bytes and the tree unblocks).
    // Round 20, finding 1: the declared size is capped (a sparse giant
    // store blinds in O(1) instead of decoding for tens of seconds).
    const text = readWholeTextViaFd(path);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return undefined;
    // Round 21, finding 1: the element-content guard — a sub-cap store
    // whose content is one giant value (the 300MiB-string shape that
    // aborted the server in the serializer) reads as UNREADABLE here, so
    // the callers take their existing degraded postures: the tier
    // resolution degrades to the caller's tier, and lockedAppend
    // QUARANTINES the file (preserve-then-write: the bytes land in the
    // .corrupt-* sidecar before the fresh store is ever written) and the
    // append proceeds. The 250MiB control stays admitted, unchanged.
    // Round 23: the skip band (above) — small files skip the walk.
    const fileBytes = statSync(path).size;
    if (fileBytes >= elementGuardSkipBandBytes() && !elementsWithinContentLimit(parsed)) return undefined;
    return parsed as unknown[];
  } catch {
    return undefined;
  }
}

// V8's string limit (~512MB on 64-bit) makes readFileSync(file, 'utf8')
// throw ERR_STRING_TOO_LONG AFTER reading every byte — the round-7
// permanent class. Round 17, finding 3: a file KNOWN to be over the limit
// is skipped BEFORE the read (the same no-lines outcome at O(1) — the
// late-throw cost was ~1.4s per 588MB sidecar, paid by the tier
// resolution's merged view and the take's fold attempt on EVERY append
// for as long as the operator leaves the file in place).
// HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT (bytes) tightens the guard for
// tests — a lower limit skips MORE whole reads (fewer lines visible).
// The env override is honored as given in EITHER direction (any
// positive integer); the safe direction is DOWN (the tests only tighten
// it), and the streaming seq scan still floors the counter from the
// skipped file's bytes.
// The default guard: just under V8's ~512MB string limit.
const WHOLE_FILE_STRING_LIMIT_BYTES = 500 * 1024 * 1024;

function wholeReadLimitBytes(): number {
  const override = Number(process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT);
  return Number.isSafeInteger(override) && override > 0 ? override : WHOLE_FILE_STRING_LIMIT_BYTES;
}

// The STREAMING scan's own declared-size cap (round 20, finding 1): the
// scan streams in 1MiB chunks so V8's string limit does not bind it, but
// an uncapped read is O(declared size) — a sparse sidecar buys hours of
// CPU-bound scanning for ~8KiB of disk. The cap defaults to the same
// 500MB discipline; HUAWEICLOUD_LEDGER_STREAM_LIMIT is its own seam so
// the whole-read test seam (which stages SMALL sidecars the stream must
// still read) does not blind them. Like the whole-read seam, the env
// override is honored as given in either direction (any positive
// integer; the tests only tighten it).
const STREAM_SCAN_LIMIT_BYTES = WHOLE_FILE_STRING_LIMIT_BYTES;

function streamScanLimitBytes(): number {
  const override = Number(process.env.HUAWEICLOUD_LEDGER_STREAM_LIMIT);
  return Number.isSafeInteger(override) && override > 0 ? override : STREAM_SCAN_LIMIT_BYTES;
}

// The ELEMENT-content bound (round 21, finding 1, seat 2 — the deepest
// class of the round: a whole-server abort no catch can see): the r20 caps
// bound the DECLARED size of a file, not the memory the append allocates
// after an admitted read. A sub-cap store (300MiB, under the 500MiB cap)
// whose content is one large JSON string parses fine alone, but the
// append's whole-store JSON.stringify — with the tier resolution's parse
// and lockedAppend's own parse both still live — puts three file-sized
// strings in flight and V8 aborts from INSIDE the serializer (FATAL
// ERROR: Zone Allocation failed), which is NOT a JS throw: lockedAppend's
// catch never runs, the whole MCP server dies (SIGABRT over the wire,
// reproduced against the bundled dist), and the unchanged store makes it
// a permanent kill switch — every later ask-mode arrival aborts again.
// The spool twin (one 300MiB line) aborts the first append the same way,
// and the ledger's own compaction mints the poisoned store from it. The
// realistic many-small-rows store at exactly the cap completes (23.5s,
// 3.47GiB peak) — the aborting shape is exactly the giant-single-value
// content a cap exists to bound, admitted because its declared size is
// legal. The fix bounds the PARSED ARTIFACT per element: any single
// store/fold element whose content exceeds the bound reads as
// unreadable — the store path quarantines (bytes preserved, the
// preserve-then-write doctrine), the fold path keeps the taken file
// (the r7 read-failure posture, retried, never dropped), the append
// lands in a fresh store, the call completes. The bound sits above the
// measured-good 250MiB control (admitted, behavior unchanged) and below
// the measured-abort 300MiB shape, with the whole-array serialization
// ALSO replaced by a streamed per-element write (below) so the admitted
// band's write never amplifies: per-element serialization is bounded by
// this guard, the write buffer by construction.
const LEDGER_ELEMENT_CONTENT_LIMIT_BYTES = 256 * 1024 * 1024; // 256MiB: 250MiB control admitted, 300MiB shape quarantined

// The element bound's test seam (round 23): safe-DIRECTIONAL only — an
// override is honored only when it TIGHTENS the bound (a lower limit
// rejects more, the same posture as the whole-read/stream seams' lower
// direction; a higher value is ignored, because raising the bound past
// the measured 2^28 abort cliff would be the unsafe direction). Lets the
// pins exercise the guard's admission decision (quarantine/keep vs
// write-into-store) at KB staging instead of 256MB.
function elementContentLimitBytes(): number {
  const override = Number(process.env.HUAWEICLOUD_LEDGER_ELEMENT_LIMIT);
  return Number.isSafeInteger(override) && override > 0 && override < LEDGER_ELEMENT_CONTENT_LIMIT_BYTES
    ? override
    : LEDGER_ELEMENT_CONTENT_LIMIT_BYTES;
}

// The guard's skip band (round 23, finding 3's cost mitigation): the
// per-element byte walk is O(total content bytes) per append, which
// measured ~+0.3-0.5s on an 87MB store and pushed a borderline live-writer
// race over the 3s wait cap. For files UNDER the band the walk is
// provably unnecessary in the SAFETY direction: an element's
// RE-SERIALIZED bytes never exceed its share of the FILE's bytes by
// enough to matter — escapes shrink on parse ("\u00e9" is 6 file
// bytes, the re-serialized "é" is 4); numbers CAN grow in serialized
// form (a file's compact "1e5" is 3 bytes, re-serialized "100000" is
// 6) but the growth is bounded by the digit count the file itself
// spent, and the structural slack is the ~3 bytes of quotes and the
// newline the file already carries — so every
// element of a file under the band has true serialized bytes under the
// band < limit, and admission cannot reach the abort cliff. The walk
// above the band stays the conservative padded-score check (its
// structural padding can only over-refuse, the safe direction).
// Realistic stores (every ledger-written tree is far under 64MiB) skip
// the walk entirely; only genuinely giant files pay it, and those are
// the ones the guard exists to examine.
function elementGuardSkipBandBytes(): number {
  return elementContentLimitBytes() / 4;
}

// An element's content size, computed WITHOUT serialization (round 21:
// measuring by serializing is the very allocation the bound exists to
// prevent): a string's UTF-16 length (the JS-string size the serializer
// would produce), an object's summed string-property lengths plus
// structural overhead, recursing into nested arrays/objects. O(1) per
// string, O(properties) per row — a consent row is ~8 properties.
// Round 23, finding 3 (seat 1's addendum): the score is in UTF-8 BYTES —
// the domain the write actually pays. The r21/r22 form scored a string by
// its UTF-16 unit count, which is memory-safe only in the ASCII regime
// (units == bytes): a 130Mi-unit CJK element (390MB of file, under BOTH
// the 256Mi-unit guard and the 500MB read cap) was ADMITTED and the write
// aborted the process — Zone Allocation failed in the stringify, the
// same measured 125Mi-answers/130Mi-aborts cliff the seat bisected; the
// hole had sat inside the r21 admitted band since that round because
// every giant-element acceptance ran ASCII. UTF-8 is at most 3 bytes per
// BMP unit (exactly the CJK x3 regime) and 4 bytes per astral pair, so
// byte-anchoring is the honest bound: ASCII behavior is IDENTICAL (bytes
// == units — the 2x249MiB pair control stays admitted), and multibyte
// content is measured at what the serializer will actually emit —
// over-bound multibyte stores quarantine with their bytes, the r21
// doctrine, never an abort. Buffer.byteLength measures without
// serializing (the r21 no-serialization rule holds: it is a walk, not an
// allocation).
function elementContentUnits(entry: unknown): number {
  if (typeof entry === 'string') return Buffer.byteLength(entry, 'utf8');
  if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null || entry === undefined) return 16;
  if (Array.isArray(entry)) {
    let total = 16;
    for (const item of entry) total += elementContentUnits(item) + 4;
    return total;
  }
  if (typeof entry === 'object') {
    let total = 256; // structural overhead: braces, quotes, commas
    const record = entry as Record<string, unknown>;
    // Round 23, finding 1: property NAMES are content too. The r21 form
    // walked Object.values only, so a row whose poison sits in a KEY
    // ({"<260MiB key>":1} scores 280 units) was ADMITTED and the write's
    // JSON.stringify aborted the process — Zone Allocation failed, not a
    // JS throw, the catch never ran, and the unchanged store made it a
    // permanent kill switch (the value control quarantined correctly at
    // the same size). Keys serialize into the piece exactly like values,
    // and in the same byte domain (round 23, finding 3).
    for (const key of Object.keys(record)) {
      total += Buffer.byteLength(key, 'utf8') + 8;
      total += elementContentUnits(record[key]) + 8;
    }
    return total;
  }
  return 16;
}

// True when every element of a parsed store/fold batch is within the
// element bound — the admission test for anything about to be serialized
// into the store. Round 23, finding 2: the bound is EXCLUSIVE (>=) — the
// r21 form rejected only `>`, so an element of EXACTLY the bound
// (2^28 units) was admitted and the parse->slice->stringify path aborted
// (the flatten at exactly 2^28; 2^28-1000 completes): the admitted band
// must be WRITABLE, and the exact-bound element now reads as over-bound
// with the same quarantine/keep posture as everything above it.
function elementsWithinContentLimit(entries: unknown[]): boolean {
  for (const entry of entries) {
    if (elementContentUnits(entry) >= elementContentLimitBytes()) return false;
  }
  return true;
}

// Open a ledger data file for reading WITHOUT the blocking hazard, with
// the FD's own identity — not the path's — deciding (rounds 18-19): the
// open carries O_NONBLOCK, so a FIFO's open returns immediately instead
// of waiting for a writer (a regular file ignores the flag entirely), and
// the fstatSync validates THE INODE THE OPEN LANDED ON — a FIFO, device,
// socket, or directory renamed over the path after any stat is caught AT
// the open, killing the stat→open TOCTOU by construction (round 19,
// finding 4, both seats: a rename storm swapped a FIFO in between the
// r18 stat and the open and wedged the append inside the lock's hold,
// the heartbeat keeping the claim fresh so takeover never fired). A
// non-regular entry is a BLINDED source, never read; an absent or
// unopenable path reads the same (undefined) — one posture for every
// failure, bounded by construction.
function openRegularForRead(path: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return undefined; // FIFO/device/directory/socket: blinded, never read
    }
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort: a leaked descriptor is the least harm here
      }
    }
    return undefined; // absent or unopenable: the same blinded posture
  }
}

// Whole-file text read through the guarded open (rounds 19-20): EVERY
// ledger read seam — the main store, the outcomes side channel, the spool
// and its .taken-* sidecars — opens through openRegularForRead, so a
// non-regular entry anywhere on the read path blinds in bounded time
// instead of wedging the append (the r18 fix guarded the spool-shaped
// seams only; a FIFO parked at the STORE or OUTCOMES path wedged the tier
// resolution, the append, the real callTool face, and cross-process — the
// degraded path re-entered the same blocking read past its 3s cap, S5).
// Round 20, finding 1 closed the other unbounded axis: the r19 doctrine
// bounded the OPEN, not the READ — a REGULAR sparse file (one truncate,
// ~8KiB of disk, any declared size) passed the isFile guard by design and
// the read streamed O(declared size): a sparse 8GiB store cost the
// approved call 23s (the utf8 decode of the whole extent before the late
// ERR_STRING_TOO_LONG), and the streaming scan measured 2.6-3.6s/GiB —
// ~7-15 hours at the ext4 maximum, inside the lock hold, the heartbeat
// suppressing takeover. The DECLARED size is now capped at every seam: a
// file whose fd declares more than the whole-read limit blinds in O(1)
// (the same posture as the unreadable class — over-limit by the store's
// own definition). Legitimate files under the cap are unchanged; the
// 500-512MB sliver that previously parsed now degrades honestly.
function readWholeTextViaFd(path: string): string | undefined {
  const fd = openRegularForRead(path);
  if (fd === undefined) return undefined; // absent, unopenable, or non-regular
  try {
    if (fstatSync(fd).size > wholeReadLimitBytes()) return undefined; // over-limit: blind in O(1)
    return readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort: the read is complete or failed regardless
    }
  }
}

// The spool-shaped whole read (the sidecars are line-oriented append-only
// files; a past-limit one reads as no lines at O(1) while the streaming
// scan still floors from its seq fields up to its own cap, below).
function readSpoolTextWhole(path: string): string | undefined {
  return readWholeTextViaFd(path);
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
// mid-fold-failure compaction from losing the main write), and a file
// past the whole-read limit reads as no lines BEFORE the bytes are read
// (round 17, finding 3 — its seq fields still floor the counter through
// the streaming scan).
function spoolLinesOf(path: string): string[] {
  const text = readSpoolTextWhole(path);
  if (text === undefined) return [];
  return text.split('\n').filter((line) => line.trim().length > 0);
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
// erase anything because it never REWRITES the file it appends to (the
// tail inspection reads one byte; a read cannot erase). Concurrent appenders interleave lines; the kernel serializes the
// size-update+write per open descriptor, and each line is a single small
// write. The tail inspection is the round-7 discipline: a torn tail (a
// disk-full clamp, a crash mid-append, a short write) must not GLUE the
// next committed line onto the fragment — the terminator isolates it.
function appendLineAdditively(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a+', 0o600);
    try {
      const stat = fstatSync(fd);
      // Round 19: the additive write seams take the same non-regular
      // posture as the reads — a FIFO at the spool or outcomes path opens
      // ('a+' is O_RDWR: a FIFO is its own reader) and accepts writes
      // into its pipe buffer until the buffer fills, then BLOCKS forever
      // on the approved call's tail. The fd's own identity decides: a
      // non-regular entry is never written (the best-effort skip — the
      // same posture as a failed write).
      if (!stat.isFile()) return;
      const start = stat.size;
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
      // Oversized-for-whole-read files are skipped BEFORE the bytes
      // (round 17, finding 3): the retry would throw late every compaction.
      const text = readSpoolTextWhole(file);
      if (text === undefined) return; // keep the file, bytes intact — the next compaction retries
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      // Round 21, finding 1: the fold is ALL-OR-NOTHING per file under the
      // element-content guard — a giant single line (the 300MiB spool twin
      // of the abort shape) would otherwise land in the store as one
      // string element and abort the append's serialization on THIS and
      // every later arrival. A file with any over-bound element is kept
      // like a read failure (the r7 posture: bytes intact, retried every
      // compaction, never dropped) and the store write proceeds without
      // it — the call completes.
      const batch: unknown[] = [];
      for (const line of lines) {
        const parsed = parseSpoolLine(line);
        batch.push(parsed === undefined ? line : parsed.parsed);
      }
      // Round 23: the skip band (above) — small spool files skip the walk.
      if (statSync(file).size >= elementGuardSkipBandBytes() && !elementsWithinContentLimit(batch)) {
        return; // keep the file: retried, evidence preserved
      }
      // Round 22, finding 2 (A2): the r21 refactor's events.push(...batch)
      // spread overflows V8's argument limit past ~125k elements — the
      // RangeError was swallowed by this catch, so a >125k-line degraded
      // spool NEVER compacted (measured: 125000 folds, 130000 silently
      // stranded, every append re-reading the 24.7MB file inside the lock;
      // the pre-r21 one-at-a-time loop folded the same spool cleanly).
      // The plain loop restores the pre-r21 shape at the r21 guard's cost.
      for (const item of batch) events.push(item);
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

// The streamed store write (round 21, finding 1): the store array is
// serialized PER ELEMENT through a bounded buffer — '[' + row + ',' + … +
// ']' — instead of one whole-array JSON.stringify. The r20 shape put the
// entire future store's serialization in one zone-allocated buffer that
// doubles its way up (256MiB->512MiB needs 768MiB contiguous), and with
// the tier resolution's parse and lockedAppend's own parse of the same
// file both live, three file-sized strings coexisted at the stringify:
// V8 aborted from inside the serializer (Zone Allocation failed — not a
// JS throw, invisible to every catch, the whole server died). Every
// element reaching this writer is already inside the element-content
// bound (the read and fold guards above), so each per-element
// serialization is bounded; the write buffer is ~1MiB by construction;
// the bytes produced are IDENTICAL to the whole-array stringify (the JSON
// array grammar element-for-element — structure pins read the store).
function writeStoreArrayAtomic(tmpPath: string, batches: unknown[][]): void {
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    // writeSync can return a PARTIAL count (RLIMIT_FSIZE, a full disk's
    // last block): a write loop that ignores the count accepts a
    // TRUNCATED file as complete — the tmp would be renamed over the
    // store mid-row and the folded taken files removed (evidence loss,
    // the exact r7-3 class; caught by the r8 organic probe's
    // capped-child leg, where the pre-r21 writeFileSync threw EFBIG on
    // the second attempt and left the taken files in place). Round 22,
    // finding 1 (BOTH seats): the r21 loop was byte-safe ONLY for ASCII —
    // writeSync's return counts BYTES while the loop sliced and bounded
    // by UTF-16 code units, so for non-ASCII content a short count either
    // exited "successfully" with the piece's tail never written (units <=
    // W < bytes: the truncated tmp landed as the store, taken file
    // removed, exit 0 — the natural RLIMIT_FSIZE shape: storeParses=false
    // at 61440 bytes, taken gone) or resumed misaligned mid-multibyte
    // (W < units: a span silently dropped, the store still parsing —
    // 14852 vs 18430 bytes — the "never rewrites" doctrine broken without
    // any detectable marker). The piece is now encoded ONCE and the loop
    // runs over BYTE offsets — the read side's own discipline — so the
    // byte-identity of the landed store holds by construction for ANY
    // content; a zero-progress write still throws so the caller's catch
    // keeps the taken files.
    const writeAll = (text: string): void => {
      const buf = Buffer.from(text, 'utf8'); // encode once: byte offsets from here on
      let at = 0;
      for (;;) {
        const wrote = writeSync(fd, buf.subarray(at));
        if (wrote <= 0) throw new Error('the store write made no progress');
        at += wrote;
        if (at >= buf.byteLength) return;
      }
    };
    let buffer = '';
    const flush = (): void => {
      if (buffer.length > 0) {
        writeAll(buffer);
        buffer = '';
      }
    };
    buffer += '[';
    let first = true;
    for (const batch of batches) {
      for (const element of batch) {
        buffer += first ? '' : ',';
        first = false;
        const piece = JSON.stringify(element);
        // A single element's serialization can exceed the flush buffer
        // (an admitted up-to-256MiB string element): write it directly,
        // never holding two oversized pieces at once.
        if (piece.length > 1024 * 1024) {
          const head = buffer;
          buffer = '';
          if (head.length > 0) writeAll(head);
          writeAll(piece);
        } else {
          buffer += piece;
          if (buffer.length >= 1024 * 1024) flush();
        }
      }
    }
    buffer += ']';
    flush();
  } finally {
    closeSync(fd);
  }
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
    // The seq assignment runs HERE, inside the lock's hold, floored by the
    // data this section already parsed (round 15, findings 1 and 4) plus the
    // streamed .taken-* scan (rounds 16-17): the store rows, the taken spool
    // events, the sidecar seq fields, and this process's last assignment.
    // No merged-view read, no seq-file trust (round 17, finding 1: the file
    // is an optimization, never a decision-maker) — the parsed and streamed
    // floor keeps the r14 durability guarantee (no source the reader can
    // see is invisible to the floor) at zero whole-file string reads.
    assignSeqsLocked(events, existing, spool.events, spool.folded);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      // Round 21, finding 1: the streamed per-element write (bounded
      // memory by construction) — see writeStoreArrayAtomic above.
      writeStoreArrayAtomic(tmp, [existing, spool.events, events]);
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
  // The seq starts UNKNOWN and is assigned by the ledger inside the write
  // path (rounds 13-15) — the caller cannot game or clock-order it, and an
  // append that dies before assignment leaves the sentinel (the annotate
  // then finds no row with that identity and skips — absence never proves
  // ownership, the round-12 doctrine).
  event.arrivalSeq = SEQ_UNKNOWN;
  // Inside a degraded section already: additive, no acquisition attempt.
  // The assignment rides inside the write bodies: the locked body assigns
  // under the ledger lock's hold (locked writers serialize for real), the
  // degraded body assigns inside its own degraded section.
  if (degradedDepth > 0) {
    assignSeqDegraded(event);
    spoolAppend([event]);
    return;
  }
  try {
    withDepLock(
      // lockedAppend assigns the seq from its parsed+streamed floor
      // (rounds 15-17): store rows + taken spool events + the sidecar
      // scan + this process's last assignment — no merged-view read, no
      // seq-file trust.
      () => lockedAppend([event]),
      ledgerLockDir(),
      LEDGER_LOCK_TAKEOVER_MS,
      LEDGER_HEARTBEAT_MS,
      LEDGER_MAX_WAIT_MS,
    );
  } catch {
    // Acquisition failed (budget, unhostable tree, read-only claim): the
    // spool is the degraded append — lockedAppend never runs unlocked.
    // The assignment is the degraded one (file + last assignment, or the
    // merged-view repair when the file is invalid) and remains the
    // recorded duplicate residual: it cannot hold the lock.
    assignSeqDegraded(event);
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
    // Round 15, finding 1: a sentinel row's chronology is UNKNOWN — it can
    // never name the original (a corrupted or pre-field row must not
    // fabricate an upgrade when the wall clock, or a hand-staged stall,
    // would hand it the win). Keys whose only granted rows are sentinel
    // rows resolve as fresh keys: the caller's tier.
    if (event.arrivalSeq === SEQ_UNKNOWN) continue;
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
// Returns the arrival's IDENTITY — the stamp AND the seq the ledger
// assigned (round 15, finding 2). See the return statement below.
export function recordAskModeConsent(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  outcome: 'granted' | 'denied';
  evidence?: ConsentEvidence;
  arrivalSeq?: number;
  // The command-forward line the summarize view rendered (already redacted
  // by the spec's contract); written on the row so the consent record names
  // what the user allowed, not only its hash.
  command?: string;
  // The consent's scope. 'once' (the default) is every ordinary arrival
  // and every PR-3a memo reuse. 'session' is the S3 session standing
  // consent grant (PR-3a): the elicitation form's "remember for this
  // session" tick — the grant row the doctor lists and the gate's
  // in-memory standing map keys rides. Tier resolution below applies
  // identically to both scopes: a reuse inherits the original's tier and
  // never upgrades (the PR-1 ledger rule; the round-10 G2 note's
  // tier-safe-writer contract).
  scope?: 'once' | 'session';
  // The caller knows WHICH channel answered this arrival and wants that
  // channel recorded (PR-1.5's ladder: an elicitation form answer is
  // `elicitation`, a chat-round-trip retry is `posture`). Without this the
  // ledger inherits the earliest granted row's tier on the consent key —
  // PR-1's reuse rule, which would label a chat retry `elicitation` whenever
  // a form had answered the same key earlier (a fabricated upgrade: the row
  // would claim a form nobody answered for this arrival). Memo reuse keeps
  // the inheriting path; a channel-verified arrival opts out.
  evidenceFinal?: boolean;
}): { grantedAt: number; arrivalSeq: number } {
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
  const event: ConsentEvent = {
    sessionId: params.sessionId,
    tool: params.tool,
    argsHash: params.argsHash,
    outcome: params.outcome,
    grantedAt,
    scope: params.scope ?? 'once',
    evidence: 'posture', // resolved below, before the append
    arrivalSeq: 0, // appendConsentEvent assigns the real counter
  };
  if (params.command !== undefined && params.command !== '') event.command = params.command;
  withLedgerLock(() => {
    let evidence = params.evidence ?? 'posture';
    if (!params.evidenceFinal) {
      try {
        const original = originalGrantedFor(params.sessionId, params.tool, params.argsHash);
        if (original) evidence = original.evidence;
      } catch {
        // degrade to the caller's tier: the append is the fact that matters
      }
    }
    event.evidence = evidence;
    appendConsentEvent(event);
  });
  // Round 15, finding 2: the arrival's IDENTITY — the stamp AND the seq the
  // ledger assigned. The dispatch layer threads both to the delivery
  // recorder, whose annotate binds the outcome line to EXACTLY the row this
  // arrival wrote (ownership by identity, never by position: the positional
  // capture let a same-ms degraded twin compacted in behind the dispatch's
  // own row steal the delivery outcome). A dropped append returns the
  // sentinel seq — no row matches it, and the annotate skips.
  return { grantedAt, arrivalSeq: event.arrivalSeq };
}

// The delivery-outcome follow-up (round 10, finding 4, both seats' shape):
// annotate the most recent granted consent row on a key with what became of
// the call the consent authorized. The gate records the ARRIVAL
// (recordAskModeConsent, above); the dispatch layer — which is the only
// place that ever sees the handler's return or throw — calls this
// best-effort follow-up after the handler ran. The ledger's subject widens
// accordingly: the CONSENT's lifecycle (arrival + what became of the call
// it authorized), never the handler's internal execution. The annotation
// is the AUDIT record of the delivery class; PR-3a's retry memo (the
// gate's in-memory state, approval-gate.ts) keys on the dispatch layer's
// COMPUTED outcome at dispatch time and never reads this annotation back.
//
// Best-effort in every direction, by design: the annotation is
// LOCKLESS — it never takes the ledger lock (a wedged holder must not
// tax the approved call's tail a second time after the arrival already
// paid the 3s cap) and never writes the main store; it appends ONE line
// to the additive outcomes side channel (.outcomes.jsonl). It SKIPS on
// any failure — no store, an unreadable store, or the row not found.
// "Not found" is the common healthy skip: token mode records no arrival
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
// arrival wrote it; the AUDIT VIEW of an absent outcomeDetail reads as
// delivery-unknown. The recorded residual narrows to the RACING shape alone: concurrent
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
    // Round 19, finding 1: the outcomes channel's read runs through the
    // guarded open (a FIFO at this path wedged every readConsentEvents —
    // the tier resolution reaches it on the way IN of every arrival);
    // unreadable-or-non-regular reads as no lines: the rows keep their
    // arrival shape, the documented side-channel tolerance. Round 20,
    // finding 1: the declared size is capped (a sparse giant channel
    // blinds in O(1)).
    const text = readWholeTextViaFd(path);
    if (text === undefined) return;
    lines = text.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return; // unreadable side channel: the rows keep their arrival shape
  }
  if (lines.length === 0) return;
  const rowIndexOf = new Map<string, number>();
  // Round 17, finding 4 (both seats — the reader side of the r16
  // finding-6 guard): the seq-keyed index takes only VALID seqs — a row
  // whose seq is out of space (the ceiling band, the sentinel, Infinity,
  // absent) has no provable identity and is never a bind target, the
  // reader's mirror of the writer's "a sentinel identity binds nothing".
  // A DUPLICATED (key, stamp, seq) identity — two rows, one identity, the
  // r15-era racing residual — is marked AMBIGUOUS (-1) and binds nothing:
  // the reader's mirror of the writer's count-and-skip, never array-last.
  // The r15-era writer emitted exactly these lines (no range check on the
  // threaded identity) and the channel is append-only, so a mixed-version
  // fleet carries them; the reader must consume them safely.
  const rowSeqIndexOf = new Map<string, number>();
  const bound = Math.min(storeRowCount, out.length);
  for (let i = 0; i < bound; i += 1) {
    const event = out[i]!;
    const triple = `${event.sessionId}\0${event.tool}\0${event.argsHash}\0${event.grantedAt}`;
    rowIndexOf.set(triple, i);
    if (!isValidArrivalSeq(event.arrivalSeq)) continue; // unknown chronology: no identity
    const seqKey = `${triple}\0${event.arrivalSeq}`;
    rowSeqIndexOf.set(seqKey, rowSeqIndexOf.has(seqKey) ? -1 : i);
  }
  // Round 15 (A2's cell 3): LEGACY lines apply first, then SEQ — the
  // seq-bearing line is the precise identity (the dispatch's own row), so
  // it wins over any legacy line at the same row regardless of file order
  // (a mixed-version fleet writing both shapes cannot have a pre-seq line
  // overwrite a seq-bound datum). Each line parses ONCE here (the
  // pre-r15 shape re-parsed in the apply pass); the apply pass is one
  // parameterized loop — the seq keying adds the row's identity to the
  // legacy triple. Round 17, finding 4: a line whose arrivalSeq is outside
  // the assignable space is DROPPED entirely — it names an unprovable
  // identity (the writer's r16 rule), and treating it as legacy would let
  // it bind a row at the stamp positionally.
  const legacyRows: Partial<OutcomeLine>[] = [];
  const seqRows: Partial<OutcomeLine>[] = [];
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
    if (isValidArrivalSeq(row.arrivalSeq)) seqRows.push(row);
    else if (row.arrivalSeq === undefined) legacyRows.push(row);
    // else: an out-of-space seq — no identity, never legacy: dropped
  }
  // One apply pass, parameterized by keying: legacy lines by the
  // (key, stamp) triple, seq lines by the full (key, stamp, seq) identity.
  // LEGACY runs first so the seq-bearing line — the precise identity —
  // wins over any legacy line at the same row regardless of file order.
  const applyOutcomeRows = (rows: Partial<OutcomeLine>[], seqKeyed: boolean): void => {
    for (const row of rows) {
      const triple = `${row.sessionId}\0${row.tool}\0${row.argsHash}\0${row.grantedAt}`;
      const index = seqKeyed ? rowSeqIndexOf.get(`${triple}\0${row.arrivalSeq}`) : rowIndexOf.get(triple);
      if (index !== undefined && index >= 0) out[index]!.outcomeDetail = row.outcomeDetail as ConsentDeliveryOutcome;
    }
  };
  applyOutcomeRows(legacyRows, false);
  applyOutcomeRows(seqRows, true);
}

// The delivery-outcome follow-up (round 10, finding 4, both seats' shape):
// record what became of the call a consent authorized, on the consent row
// that arrival created — the AUDIT record of the delivery class (the
// retry memo's state is the gate's in-memory record, never this
// annotation). The gate records the ARRIVAL (recordAskModeConsent, which
// returns the identity it wrote — the stamp and the seq); the dispatch
// layer — the only place that ever sees the handler's return or throw —
// hands that identity here with the delivery class. The ledger's subject
// is the CONSENT's lifecycle (arrival + what became of the call it
// authorized), never the handler's internal execution.
//
// Ownership is proven by IDENTITY, never by position or absence (rounds
// 12, 15, and 16): the annotate proceeds only when the store holds
// EXACTLY ONE granted row with the arrival's (stamp, seq). Round 15,
// finding 2 (both seats) closed the positional hole: the capture used to
// scan for the last store row at key+stamp, so a same-ms degraded twin
// compacted in behind the dispatch's own row before its annotate ran
// received the line — the degraded row carrying a delivery outcome the
// annotate's own guard refuses to write, and the dispatch's row losing
// it. Round 16, finding 6 hardened the guard both ways: the threaded seq
// must be INSIDE the assignable space (a dropped or saturated arrival's
// identity IS the sentinel, and a sentinel identity binds nothing —
// ownership is not provable at an unknown chronology), each candidate
// row's seq is range-normalized before the comparison (a corrupted
// ceiling-band or sentinel-valued row never matches), and a full
// (key, stamp, seq) identity collision — two rows, one identity — is
// COUNTED and skipped, never bound by array position. The direct call
// with no threaded identity binds only a UNIQUE key+stamp match (round
// 16, finding 5: a unique match on a row without a valid seq binds too —
// the line carries no arrivalSeq and the legacy fold rule applies; the
// r15 conjunct had silently narrowed the stated contract and left the
// legacy fold unreachable by any writer); ambiguity skips — never
// positional. An arrival whose append was silently dropped
// (lockedAppend's best-effort catch — ENOSPC/EIO/EACCES, the clamp
// shapes) leaves no row anywhere, so the identity matches nothing and
// the annotate is a no-op: the earlier call's row on the same key keeps
// its own datum. An arrival that degraded to the spool or a taken sidecar
// fails the same test (its row is not store-resident), which also
// enforces the r10/r11 posture — degraded arrivals carry no delivery
// outcome — and the outside-store guard (round 11, finding 1) still skips
// when any granted row on the key outside the store carries a stamp at
// or beyond this arrival's (this call's arrival degraded, a newer arrival
// lives outside the store, or an equal-stamp ambiguity).
//
// Best-effort in every direction: lockless (it writes only the additive
// side channel, so there is nothing to serialize and no holder to
// depose), skip on any failure, never throw, and never write the main
// store — the annotate may skip, never erase. A skipped or dropped
// annotation leaves the row as the arrival wrote it; the memo treats an
// absent outcomeDetail as unknown. The recorded residual is the RACING
// same-key shape alone (concurrent arrivals interleaving between arrival
// and annotate — PR-3a's keyed join lands with the approvedVia carrier,
// the recorded G2 note), plus the same-millisecond equal-stamp pairs a
// direct (no-seq) call cannot disambiguate — skipped, never positional.
export function annotateDispatchOutcome(params: {
  sessionId: string;
  tool: string;
  argsHash: string;
  arrivalStamp?: number;
  // The arrival's seq, threaded from recordAskModeConsent's return through
  // the gate and the dispatch layer (round 15, finding 2) — the dispatch's
  // own identity. Optional for direct callers (probes, legacy): see the
  // unique-match fallback below.
  arrivalSeq?: number;
  outcomeDetail: ConsentDeliveryOutcome;
}): void {
  try {
    if (typeof params.arrivalStamp !== 'number') return; // no stamp: never annotate
    const raw = readRawConsents();
    if (raw === undefined) return; // absent or unreadable store: nothing to annotate
    // Round 15, finding 2 (both seats): the capture used to take the LAST
    // raw-store row matching key+stamp — a positional ownership rule, so a
    // same-ms degraded twin compacted in BEHIND the dispatch's own row
    // before its annotate ran received the line (the twin carried a
    // delivery outcome the annotate's own guard refuses to write; the
    // dispatch's row lost it). The identity is now THREADED, never
    // captured: the dispatch's own (stamp, seq) names the exact row, and
    // the guard verifies that exact row exists in the store.
    let arrivalSeq: number | undefined;
    let arrivalPresent = false;
    // The guard prefix both captures share: the row must be this key's
    // granted arrival at the arrival's stamp. The threaded capture adds
    // the seq conjunct; the fallback counts matches instead.
    const rowAtKeyAndStamp = (entry: unknown): Record<string, unknown> | undefined => {
      if (!entry || typeof entry !== 'object') return undefined;
      const record = entry as Record<string, unknown>;
      return record.sessionId === params.sessionId &&
        record.tool === params.tool &&
        record.argsHash === params.argsHash &&
        record.outcome === 'granted' &&
        record.grantedAt === params.arrivalStamp
        ? record
        : undefined;
    };
    if (params.arrivalSeq !== undefined) {
      // The threaded face (rounds 15-16). Round 16, finding 6 (both legs):
      // (a) the raw guard used to compare arrivalSeq by === with no range
      // normalization — a sentinel-valued row (the exact shape-only class
      // round 15 named) bound a sentinel identity, and a row staged in the
      // ceiling band matched a threaded ceiling value. The comparison now
      // requires the threaded identity to be INSIDE the assignable space
      // and normalizes each candidate row the same way — an unknown or
      // unreadable seq never matches, so a dropped/saturated arrival
      // (whose identity IS the sentinel) binds NOTHING: ownership is not
      // provable at an unknown chronology, and an invalid threaded
      // identity never falls through to the positional fallback.
      // (b) At a full (key, stamp, seq) identity collision — two rows,
      // one identity, the intersection of finding 2's duplicate with the
      // same-ms racing residual — the guard used to bind array-last,
      // positional; indistinguishable pairs are COUNTED and skipped
      // instead, never bound by position.
      if (isValidArrivalSeq(params.arrivalSeq)) {
        let matches = 0;
        for (const entry of raw) {
          const record = rowAtKeyAndStamp(entry);
          if (record !== undefined && isValidArrivalSeq(record.arrivalSeq) && record.arrivalSeq === params.arrivalSeq) {
            matches += 1;
          }
        }
        if (matches === 1) {
          arrivalSeq = params.arrivalSeq;
          arrivalPresent = true;
        }
        // matches === 0: no row with the identity; > 1: an indistinguishable
        // pair — skip, never positional.
      }
      // An invalid threaded identity (the sentinel a dropped, saturated, or
      // blinded append returned): binds nothing — the annotate skips.
    } else {
      // The direct-call fallback (no threaded identity): the store row at
      // key+stamp is bound ONLY when it is UNIQUE — ambiguity (the twin
      // shape) skips, so a legacy/probe call can never bind the wrong row.
      // Round 16, finding 5: a unique match on a row WITHOUT a seq field
      // binds too (the r15 conjunct silently narrowed the stated contract
      // and left the legacy-line fold unreachable by any writer) — the
      // line then carries no arrivalSeq and the legacy fold rule applies.
      // Round 16, finding 6(a) applies here as well: a row whose seq is
      // PRESENT but out of space is UNREADABLE — not a legacy row, never
      // a candidate; only an ABSENT seq (the pre-field legacy shape) or a
      // VALID seq counts.
      let matches = 0;
      let uniqueSeq: number | undefined;
      for (const entry of raw) {
        const record = rowAtKeyAndStamp(entry);
        if (record === undefined) continue;
        if (record.arrivalSeq === undefined || record.arrivalSeq === null) {
          matches += 1; // the legacy shape: no seq field at all
          continue;
        }
        if (!isValidArrivalSeq(record.arrivalSeq)) continue; // unreadable: never a candidate
        matches += 1;
        uniqueSeq = record.arrivalSeq;
      }
      if (matches === 1) {
        arrivalSeq = uniqueSeq;
        arrivalPresent = true;
      }
      // matches !== 1: ambiguous or absent — never positional.
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
