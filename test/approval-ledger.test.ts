import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { contendOneAppend, spawnLedgerWorker, waitForLedgerClaim } from './approval-ledger-harness.ts';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  annotateDispatchOutcome,
  appendConsentEvent,
  readConsentEvents,
  recordAskModeConsent,
} from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { hashArgs } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import type {
  ConsentDeliveryOutcome,
  ConsentEvent,
  ConsentEvidence,
} from '../plugins/huaweicloud-core/src/approval-types.ts';
import { fixtureDir } from './fixture-dir.ts';

// The consent ledger's round-trip battery: events persist, malformed store
// entries read as absent, the evidence tier is written from day one, and a
// memo-reuse event inherits the original tier without upgrading it (the
// PR-1 ledger rule the PR-3a memo consumes).

const ARGS_HASH = hashArgs(['ECS', 'DeleteServer', '--server_id=i-1']);

// Stage a raw store file under the isolated home: the tests below write
// hand-shaped stores directly, so the dir and the file land in one place.
function stageStore(home: string, contents: string): string {
  const dir = join(home, '.config', 'huaweicloud');
  const file = join(dir, 'approval-consents.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, contents);
  return file;
}

// The ledger's state-dir paths under an isolated home, with the dir
// created — the shared staging preamble of the spool-surface pins (torn
// tail, taken order).
function ledgerSpoolPaths(home: string): { dir: string; spool: string; lockRoot: string } {
  const dir = join(home, '.config', 'huaweicloud');
  mkdirSync(dir, { recursive: true });
  return { dir, spool: join(dir, 'approval-consents.json.spool.jsonl'), lockRoot: join(dir, 'approval-consents-lock') };
}

// The same-ms twin timeline's staging halves (rounds 14-15): dispatch D1's
// store row (seq 0) under the shared millisecond, and the pair that
// compacts a same-ms degraded twin (seq 1) in BEHIND it — the twin lands in
// the spool and one ordinary locked append folds it after D1's row. The
// r14 twin pin annotates BETWEEN the halves (the annotate runs before the
// compaction); the r15 capture pin annotates after both (the twin is
// already store-resident — the contested window).
function stageTwinStoreRow(home: string, key: string, T: number): void {
  stageStore(home, JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: key, grantedAt: T, arrivalSeq: 0 })]));
}

function compactTwinInBehind(paths: { spool: string }, key: string, T: number): void {
  writeFileSync(
    paths.spool,
    JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: key, grantedAt: T, arrivalSeq: 1 })) + '\n',
  );
  appendConsentEvent(baseEvent({ sessionId: 'ses-c', argsHash: 'other', grantedAt: T + 1 }));
}

// The raw row-JSON staging the bounded-space pins share (rounds 15-16):
// a granted consent row with an explicit seq, or no seq field at all when
// arrivalSeq is null.
function stagedRowJson(
  evidence: ConsentEvidence,
  grantedAt: number,
  arrivalSeq: number | null,
  argsHash: string,
): string {
  return JSON.stringify({
    sessionId: 'ses',
    tool: 'huaweicloud_run_approved_command',
    argsHash,
    outcome: 'granted',
    grantedAt,
    scope: 'once',
    evidence,
    ...(arrivalSeq !== null ? { arrivalSeq } : {}),
  });
}

// The counter-scratch wipe the round-16 pins share: the active spool, every
// .taken-* sidecar, and the seq file — the store is re-staged by the caller.
function wipeCounterScratch(paths: { dir: string; spool: string }): void {
  rmSync(paths.spool, { force: true });
  for (const name of readdirSync(paths.dir)) {
    if (name.includes('.taken-')) rmSync(join(paths.dir, name), { force: true });
  }
  rmSync(join(paths.dir, 'approval-consents.seq'), { force: true });
}

// The shared skew-leg of the chronology pins (rounds 13-14): stage a
// two-row store — the posture original at seq 0 under a fast clock, a
// failure-born terminal copy at seq 1 written later after the clock
// stepped back (grantAt 4000 < the original's 5000) — then drive ONE real
// reuse on the key and return its rows. `seqFilePresent` false removes the
// high-water file first (the missing-counter-over-non-empty-store shape).
function stageSkewPairAndReuse(home: string, key: string, seqFilePresent: boolean): ConsentEvent[] {
  const row = (evidence: ConsentEvidence, grantedAt: number, arrivalSeq: number): string =>
    JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: key, evidence, grantedAt, arrivalSeq }));
  if (!seqFilePresent) rmSync(join(home, '.config', 'huaweicloud', 'approval-consents.seq'), { force: true });
  stageStore(home, `[${row('posture', 5_000, 0)},${row('terminal', 4_000, 1)}]`);
  recordAskModeConsent({
    sessionId: 'ses',
    tool: 'huaweicloud_run_approved_command',
    argsHash: key,
    outcome: 'granted',
  });
  return readConsentEvents().filter((event) => event.argsHash === key);
}

// A staged consent line for the inheritance-order pins: one key, one
// tier, one stamp — the shape both r8 seats and r9 seats staged.
function orderLine(argsHash: string, evidence: ConsentEvidence, grantedAt: number): string {
  return JSON.stringify(baseEvent({ sessionId: 'ses-order', argsHash, evidence, grantedAt })) + '\n';
}

// The two staged sidecar names the inheritance pins use — differing only
// in the pid part, the production randomUUID coin flip's stand-in.
function orderTakenFirst(dir: string): string {
  return join(dir, 'approval-consents.json.spool.jsonl.taken-11111111-0000-4000-8000-000000000001');
}

function orderTakenLast(dir: string): string {
  return join(dir, 'approval-consents.json.spool.jsonl.taken-22222222-0000-4000-8000-000000000002');
}

// The pins' shared assertion leg: the reuse must record the ORIGINAL's
// tier. The message differs per round (distinct stamps: chronology; equal
// stamps: the tier-precedence tiebreak), so it is a parameter.
function expectOriginalTier(
  home: string,
  paths: ReturnType<typeof ledgerSpoolPaths>,
  argsHash: string,
  stage: (write: (path: string, contents: string) => void) => void,
  message: string,
): void {
  const { label, tier } = recordReuseTier(home, paths, argsHash, stage);
  assert.equal(tier, 'terminal', `${label}: ${message}`);
}

// Drive ONE real reuse on a staged consent key and return the tier the
// resolution recorded — the shared leg of the inheritance pins (rounds
// 8-9). Staging wipes the two taken sidecars and the spool and resets the
// store to empty, so the cases cannot bleed into each other; the reuse is
// degraded deterministically (unhostable lock root) and asks for
// 'elicitation' — an observable override, so any pick but the resolved
// original's tier is visible in the recorded row.
function recordReuseTier(
  home: string,
  paths: { dir: string; spool: string; lockRoot: string },
  argsHash: string,
  stage: (write: (path: string, contents: string) => void) => void,
): { label: string; tier: ConsentEvidence } {
  for (const path of [orderTakenFirst(paths.dir), orderTakenLast(paths.dir), paths.spool])
    rmSync(path, { force: true });
  stageStore(home, '[]');
  stage((path, contents) => writeFileSync(path, contents));
  writeFileSync(paths.lockRoot, 'not-a-directory');
  recordAskModeConsent({
    sessionId: 'ses-order',
    tool: 'huaweicloud_run_approved_command',
    argsHash,
    outcome: 'granted',
    evidence: 'elicitation',
  });
  rmSync(paths.lockRoot, { force: true });
  const rows = readConsentEvents().filter((event) => event.argsHash === argsHash);
  const recorded = rows.find((event) => event.grantedAt > 1_000_000_000_000);
  assert.ok(recorded, `case ${argsHash}: the reuse recorded a row`);
  return { label: argsHash, tier: recorded.evidence };
}

// Quarantine the store once: stage raw bytes, make them unreadable, append
// (which must quarantine rather than overwrite), and return the fresh
// sidecar's name with its readability restored for the caller's byte check.
function quarantineOnce(home: string, rawBytes: string, alreadySeen: string[] = []): string {
  const dir = join(home, '.config', 'huaweicloud');
  stageStore(home, rawBytes);
  const file = join(dir, 'approval-consents.json');
  chmodSync(file, 0o000); // unreadable in-process
  recordAskModeConsent({ sessionId: 'ses-new', tool: 't', argsHash: 'h', outcome: 'granted' });
  const names = readdirSync(dir);
  const sidecar = names.find((name) => name.includes('.corrupt-') && !alreadySeen.includes(name));
  assert.ok(sidecar, `a fresh quarantine sidecar must exist, got: ${names.join(', ')}`);
  chmodSync(join(dir, sidecar), 0o600);
  return sidecar;
}

function withLedgerHome(fn: (home: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const home = fixtureDir('approval-ledger-');
    const previous = process.env.HUAWEICLOUD_HOME;
    process.env.HUAWEICLOUD_HOME = home;
    try {
      await fn(home);
    } finally {
      if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = previous;
    }
  };
}

const baseEvent = (overrides: Partial<ConsentEvent> = {}): ConsentEvent => ({
  sessionId: 'ses-1',
  tool: 'huaweicloud_run_approved_command',
  argsHash: ARGS_HASH,
  outcome: 'granted',
  grantedAt: 1_700_000_000_000,
  scope: 'once',
  evidence: 'posture',
  // Round 13, finding 4: the arrival counter, constant for staged rows —
  // with equal seqs the (seq, grantedAt) chronology reduces to grantedAt,
  // so every pre-r13 chronology verdict holds; pins that exercise the
  // clock-skew key stage EXPLICIT distinct seqs.
  arrivalSeq: 0,
  ...overrides,
});

// Worker mode for the concurrency test: append N tagged events through the
// real appendConsentEvent into the parent's HUAWEICLOUD_HOME, then exit
// before any test registers — a worker runs ONLY its appends (no nested
// worker spawning, no suite re-run).
if (process.env.LEDGER_WORKER) {
  const worker = process.env.LEDGER_WORKER!;
  const perWorker = Number(process.env.LEDGER_PER_WORKER || 10);
  // Barrier mode (round 14, finding 2): wait for a marker file before the
  // first append, so a test can synchronize many workers' first
  // acquisition windows and prove the seq assignment serializes under the
  // lock (pre-fix it ran before withDepLock and duplicated seqs).
  const barrier = process.env.LEDGER_BARRIER;
  if (barrier) {
    const barrierDeadline = Date.now() + 60_000;
    while (!existsSync(barrier)) {
      if (Date.now() > barrierDeadline) process.exit(3);
      // a busy-wait: the window under test is the assignment itself, not
      // the poll cadence
    }
  }
  for (let i = 0; i < perWorker; i += 1) {
    appendConsentEvent(baseEvent({ sessionId: `worker-${worker}-${i}`, argsHash: `h-${worker}-${i}` }));
  }
  process.exit(0);
}

// Fast-path probe mode (round 15, finding 4): ONE ask-mode arrival through
// the real ledger, then write the process's outcomes-file read count to
// LEDGER_FASTPATH_COUNT_FILE and exit before any test registers. Spawned
// with the FS_COUNT_HOOK_SOURCE preload via --require (see the pin below):
// the hook patches fs.readFileSync BEFORE this file's module graph links,
// so the count covers the whole arrival — module mocks cannot rebind an
// already-linked builtin, and this file statically imports the ledger.
if (process.env.LEDGER_FASTPATH_COUNT_FILE) {
  const fastpathDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud');
  const fastpathLockRoot = join(fastpathDir, 'approval-consents-lock');
  if (process.env.LEDGER_FASTPATH_DEGRADED) {
    // The degraded probe: no seq file (the only floor source left is the
    // merged view) and the lock root blocked, so the append degrades.
    rmSync(join(fastpathDir, 'approval-consents.seq'), { force: true });
    rmSync(fastpathLockRoot, { recursive: true, force: true });
    writeFileSync(fastpathLockRoot, 'not-a-directory');
  }
  const arrival = recordAskModeConsent({
    sessionId: 'ses-fastpath',
    tool: 'huaweicloud_run_approved_command',
    argsHash: process.env.LEDGER_FASTPATH_KEY ?? 'h-fastpath',
    outcome: 'granted',
  });
  if (process.env.LEDGER_FASTPATH_DEGRADED) rmSync(fastpathLockRoot, { force: true });
  const reads = (globalThis as { __outcomesReads?: number }).__outcomesReads ?? 0;
  writeFileSync(process.env.LEDGER_FASTPATH_COUNT_FILE, `${reads} ${arrival.arrivalSeq}\n`);
  process.exit(0);
}

// Slow-holder mode for the liveness test (round-4 finding 1): hold the
// ledger lock through a 2500ms section — far past the 1000ms takeover
// window — with the heartbeat on, exactly as the real lock configures it,
// then append one tagged event from inside the section and exit. The
// blocked main thread (spawnSync sleep) is the point: only the
// worker-thread heartbeat can keep the claim fresh while the holder is
// stuck in a long section.
if (process.env.LEDGER_SLOW_HOLDER) {
  const { withDepLock } = await import('../plugins/huaweicloud-core/src/dep/receipts.ts');
  const lockDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approval-consents-lock');
  withDepLock(
    () => {
      spawnSync('sleep', ['2.5']); // a live, productive, OVER-WINDOW section
      appendConsentEvent(baseEvent({ sessionId: 'holder-event', argsHash: 'h-holder' }));
    },
    lockDir,
    1000,
    200,
  );
  process.exit(0);
}

// Wedged-holder mode (round-5 finding 1): claim the ledger lock with the
// ledger's exact parameters and BLOCK the main thread well past the wait
// cap — the worker heartbeat keeps the claim fresh, exactly the shape
// where a beating-but-wedged holder must not stall an approved call
// forever. The process is killed by the parent; it never exits on its own.
if (process.env.LEDGER_WEDGED_HOLDER) {
  const { withDepLock } = await import('../plugins/huaweicloud-core/src/dep/receipts.ts');
  const lockDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approval-consents-lock');
  withDepLock(
    () => {
      spawnSync('sleep', ['120']);
      process.exit(0);
    },
    lockDir,
    1000,
    200,
  );
  process.exit(0);
}

// Over-cap healthy holder mode (round-6 finding 2): claim the ledger lock
// with the ledger's exact parameters and run a REAL section longer than
// the wait cap (a healthy slow write — the big-store/slow-home shape),
// then append one tagged event from inside the hold. The holder is alive,
// productive, and heartbeat-fresh the whole time; the appended event lands
// through the locked path.
if (process.env.LEDGER_OVERCAP_HOLDER) {
  const { withDepLock } = await import('../plugins/huaweicloud-core/src/dep/receipts.ts');
  const lockDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approval-consents-lock');
  withDepLock(
    () => {
      spawnSync('sleep', ['4.5']); // a healthy section past the 3s cap
      appendConsentEvent(baseEvent({ sessionId: 'holder-event', argsHash: 'h-holder' }));
    },
    lockDir,
    1000,
    200,
  );
  process.exit(0);
}

test(
  'consent events round-trip through the state tree with the evidence tier intact',
  withLedgerHome(async (home) => {
    assert.deepEqual(readConsentEvents(), [], 'an absent store reads as empty');

    appendConsentEvent(baseEvent());
    appendConsentEvent(baseEvent({ outcome: 'denied', evidence: 'terminal', scope: 'session', sessionId: 'ses-2' }));

    const events = readConsentEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], baseEvent({ arrivalSeq: 0 }));
    assert.deepEqual(
      events[1],
      // Round 13, finding 4: the arrival counter is assigned per append —
      // the second row carries the second seq, whatever the caller staged.
      baseEvent({ outcome: 'denied', evidence: 'terminal', scope: 'session', sessionId: 'ses-2', arrivalSeq: 1 }),
    );

    const file = join(home, '.config', 'huaweicloud', 'approval-consents.json');
    assert.ok(existsSync(file), 'the ledger lives in the devkit state tree');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    assert.equal(raw.length, 2);
    assert.equal(raw[0]!.evidence, 'posture');
  }),
);

test(
  'recordAskModeConsent writes the posture tier for a fresh key and honors an explicit terminal tier',
  withLedgerHome(async () => {
    // Fresh key, no evidence parameter: the posture tier (an ask arrival).
    recordAskModeConsent({
      sessionId: 'ses-a',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
    });
    // Fresh key, explicit terminal: a future confirm-path record.
    recordAskModeConsent({
      sessionId: 'ses-b',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'terminal',
    });

    const events = readConsentEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.evidence, 'posture', 'a fresh ask-mode arrival records the posture tier');
    assert.equal(events[1]!.evidence, 'terminal', 'a fresh key honors the caller-provided tier');
    assert.ok(events[0]!.grantedAt > 0);
    assert.equal(events[0]!.scope, 'once');
  }),
);

test(
  'a memo reuse never upgrades the original evidence tier (the API enforces the inheritance)',
  withLedgerHome(async () => {
    // The plan's PR-1 rule: a reuse inherits the ORIGINAL event's tier and
    // never upgrades it. The enforcement lives in recordAskModeConsent —
    // it resolves the tier from the prior granted event on the same
    // consent key (sessionId + tool + argsHash), so a caller asking for
    // terminal over a posture original is refused, not trusted. This test
    // drives the WRONG tier through the API and fails if the ledger ever
    // stores it.
    recordAskModeConsent({
      sessionId: 'ses-a',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
    });
    assert.equal(readConsentEvents()[0]!.evidence, 'posture', 'the original is posture-grade');

    recordAskModeConsent({
      sessionId: 'ses-a',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'terminal', // the upgrade attempt
    });
    assert.equal(
      readConsentEvents()[1]!.evidence,
      'posture',
      'the upgrade was refused: the reuse inherits the posture original verbatim',
    );

    // The downgrade direction inherits too: a terminal original keeps
    // terminal even when the caller passes posture.
    recordAskModeConsent({
      sessionId: 'ses-b',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'terminal',
    });
    recordAskModeConsent({
      sessionId: 'ses-b',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'posture', // the downgrade attempt
    });
    assert.equal(readConsentEvents()[3]!.evidence, 'terminal', 'a reuse of a terminal original stays terminal-grade');

    // A DIFFERENT key takes the caller's tier: it is a fresh consent, not
    // a reuse.
    recordAskModeConsent({
      sessionId: 'ses-c',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'terminal',
    });
    assert.equal(readConsentEvents().at(-1)!.evidence, 'terminal', 'a fresh key takes the caller tier');

    // A denied prior is not a consent: the retry after one is a fresh
    // ask, so it takes the caller's tier rather than inheriting a denial.
    recordAskModeConsent({
      sessionId: 'ses-d',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'denied',
      evidence: 'terminal',
    });
    recordAskModeConsent({
      sessionId: 'ses-d',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
    });
    const tail = readConsentEvents().slice(-2);
    assert.equal(tail[0]!.outcome, 'denied');
    assert.equal(tail[1]!.evidence, 'posture', 'a retry after a denied arrival is a fresh ask, not a reuse');
  }),
);

test(
  'an append adds, never erases: unmodeled entries and fields survive verbatim',
  withLedgerHome(async (home) => {
    // Interrogate round 1, finding 3: the write path must append to the
    // raw store, not rewrite it from the filtered reader's view — a
    // hand-edited tier, an unmodeled field, and a malformed entry all
    // survive an append.
    const file = stageStore(
      home,
      JSON.stringify([
        'a malformed entry the reader drops',
        { ...baseEvent(), evidence: 'hand-edited-tier' },
        { ...baseEvent(), sessionId: 'ses-0', approvedVia: 'retry-uncertain' },
      ]),
    );

    appendConsentEvent(baseEvent({ sessionId: 'ses-new' }));

    const after = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    assert.equal(after.length, 4, 'the append added exactly one entry');
    assert.equal(after[0], 'a malformed entry the reader drops', 'malformed entries survive verbatim');
    assert.equal(after[1]!.evidence, 'hand-edited-tier', 'a hand-edited tier survives the append');
    assert.equal(after[2]!.approvedVia, 'retry-uncertain', 'unmodeled fields survive the append');
    assert.equal(after[3]!.sessionId, 'ses-new', 'the new event lands last');
  }),
);

test(
  'a store that cannot be read is quarantined, never overwritten',
  withLedgerHome(async (home) => {
    // The unreadable-store case (finding 3): preserve-then-write. The
    // original bytes move to a .corrupt- sidecar before the fresh store
    // is written; the append never destroys evidence it failed to read.
    const dir = join(home, '.config', 'huaweicloud');
    const rawBytes = JSON.stringify([{ sessionId: 'keep-me' }, { sessionId: 'keep-me-2' }]);
    const file = stageStore(home, rawBytes);
    const original = readFileSync(file, 'utf8');
    const sidecar = quarantineOnce(home, rawBytes);
    assert.equal(readFileSync(join(dir, sidecar), 'utf8'), original, 'the sidecar holds the original bytes');
    const fresh = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    assert.deepEqual(
      fresh.map((entry) => entry.sessionId),
      ['ses-new'],
      'the new store starts fresh',
    );
  }),
);

test(
  'a live over-window section is never stolen: the heartbeat keeps the claim fresh (round-4 finding 1)',
  withLedgerHome(async (home) => {
    // Round 4's verified race: the 1s window stole a LIVE writer's lock
    // mid-section (sections are O(store) and unbounded), both writers ran
    // from one snapshot, and the holder's committed event was silently
    // erased. The fix is liveness, not window sizing: the ledger's lock
    // claims a worker-thread heartbeat that refreshes the claim's mtime
    // while the section runs, so a beating holder is waited out however
    // long its section. The child below holds the lock for 2500ms with a
    // BLOCKED main thread; the parent contends below while the holder is
    // LIVE inside its section — it must wait the section out, not steal
    // it, and both committed events must survive.
    const { spawn } = await import('node:child_process');
    const { existsSync: fsExists } = await import('node:fs');
    const child = spawn(process.execPath, ['--experimental-strip-types', 'test/approval-ledger.test.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LEDGER_SLOW_HOLDER: '1',
        HUAWEICLOUD_HOME: home,
        NODE_TEST_CONTEXT: undefined,
        NODE_TEST_WORKER_ID: undefined,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
      // Wait for the holder to be LIVE inside its section: the claim pid
      // file exists and the child has not exited. withDepLock claims
      // <root>/lock (LOCK_DIR_NAME) with the pid inside it.
      const pidFile = join(home, '.config', 'huaweicloud', 'approval-consents-lock', 'lock', 'pid');
      const deadline = Date.now() + 30_000;
      while (!fsExists(pidFile)) {
        assert.ok(Date.now() < deadline, 'the slow holder never claimed the lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300)); // mid-section
      const started = Date.now();
      appendConsentEvent(baseEvent({ sessionId: 'parent-event', argsHash: 'h-parent' }));
      const waited = Date.now() - started;
      // A steal returns in ~the window (≤1.2s): the parent must have waited
      // out the live 2.5s section instead.
      assert.ok(waited > 1500, `the parent must wait out the live section, not steal it (waited ${waited}ms)`);
      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`holder exit ${code}`))));
        child.on('error', reject);
      });
      const ids = readConsentEvents()
        .map((event) => event.sessionId)
        .sort((a, b) => a.localeCompare(b));
      assert.deepEqual(
        ids,
        ['holder-event', 'parent-event'],
        'both the live section’s event and the waiter’s event survived — no steal, no erase',
      );
    } finally {
      child.kill();
    }
  }),
);

test(
  'a wedged beating holder never stalls the approved append past the wait cap (round-5 finding 1)',
  withLedgerHome(async (home) => {
    // Round 5's verified hole: the heartbeat runs on a worker thread, so a
    // holder wedged in its section keeps beating forever, and the waiter —
    // a synchronous poll on the caller's main thread — blocked for the
    // wedge's whole duration (measured 59.7s on a 60s wedge; unbounded
    // past that). The cap now bounds the total wait: past it the append
    // degrades to the additive spool instead of stalling the approved
    // call. The holder below claims with the ledger's exact parameters
    // and blocks for 120s; the append must return within the cap (plus
    // poll slack) and land its event.
    const child = spawnLedgerWorker(home, { LEDGER_WEDGED_HOLDER: '1' });
    try {
      await waitForLedgerClaim(home, 'wedged holder');
      await new Promise((resolve) => setTimeout(resolve, 500)); // mid-section, heartbeat live
      const started = Date.now();
      appendConsentEvent(baseEvent({ sessionId: 'contender-event', argsHash: 'h-contender' }));
      const waited = Date.now() - started;
      assert.ok(waited >= 3000, `the append must first exhaust the wait cap, not return early (waited ${waited}ms)`);
      assert.ok(
        waited < 5000,
        `the append must degrade within the cap plus poll slack, never stall (waited ${waited}ms)`,
      );
      const ids = readConsentEvents().map((event) => event.sessionId);
      assert.ok(ids.includes('contender-event'), 'the degraded append landed the contender event');
    } finally {
      child.kill();
    }
  }),
);

test(
  'a wedged holder never stalls the record path or an over-cap section erases no evidence (round-6 findings 1 and 2)',
  withLedgerHome(async (home) => {
    // Round 6, finding 1: recordAskModeConsent's section calls
    // appendConsentEvent; pre-fix, the degraded outer attempt let the
    // inner call acquire the lock AGAIN and pay the wait cap a second
    // time — the gate's ask path measured 6.05-6.09s on a wedged holder,
    // 2x the 5s bar. The degraded section is now re-entrant: ONE cap,
    // and the nested append routes to the additive spool.
    const wedged = spawnLedgerWorker(home, { LEDGER_WEDGED_HOLDER: '1' });
    try {
      await waitForLedgerClaim(home, 'wedged holder');
      await new Promise((resolve) => setTimeout(resolve, 300)); // mid-section
      const started = Date.now();
      recordAskModeConsent({
        sessionId: 'record-event',
        tool: 'huaweicloud_run_approved_command',
        argsHash: 'h-record',
        outcome: 'granted',
      });
      const waited = Date.now() - started;
      assert.ok(
        waited >= 3000,
        `the record path must first exhaust the wait cap, not return early (waited ${waited}ms)`,
      );
      assert.ok(waited < 5000, `the record path pays the cap ONCE — no nested re-acquisition (waited ${waited}ms)`);
      const ids = readConsentEvents().map((event) => event.sessionId);
      assert.ok(ids.includes('record-event'), 'the degraded record path landed its event (additive spool)');

      // Round 6, finding 2 — a healthy section PAST the cap plus one
      // contender: the erasure shape. The contender degrades and its
      // event must not be erased by the holder's whole-file write — the
      // degraded append is additive (spool), and the holder's locked
      // append compacts it. ALL events survive: the seed, the holder's,
      // the contender's.
      const seed = baseEvent({ sessionId: 'seed-event', argsHash: 'h-seed' });
      appendConsentEvent(seed);
      const holder = spawnLedgerWorker(home, { LEDGER_OVERCAP_HOLDER: '1' });
      try {
        await waitForLedgerClaim(home, 'over-cap holder');
        await new Promise((resolve) => setTimeout(resolve, 300)); // mid-section, heartbeat live
        const contendedAt = Date.now();
        recordAskModeConsent({
          sessionId: 'contender-event',
          tool: 'huaweicloud_run_approved_command',
          argsHash: 'h-contender',
          outcome: 'granted',
        });
        assert.ok(Date.now() - contendedAt < 5000, 'the contender degrades within the cap');
        await new Promise<void>((resolve, reject) => {
          holder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`holder exit ${code}`))));
          holder.on('error', reject);
        });
        const ids = readConsentEvents().map((event) => event.sessionId);
        for (const expected of ['seed-event', 'holder-event', 'contender-event']) {
          assert.ok(
            ids.includes(expected),
            `${expected} must survive the over-cap race (store+spool view: ${JSON.stringify(ids)})`,
          );
        }
      } finally {
        holder.kill();
      }
    } finally {
      wedged.kill();
    }
  }),
);

test(
  'two degraded contenders on one wedged holder both keep their consent (round-6 finding 2)',
  withLedgerHome(async (home) => {
    // The 120k-store shape from the round: a single wedged holder makes
    // EVERY concurrent contender degrade; pre-fix, two degraded
    // whole-file writes raced each other and one committed consent was
    // silently erased. Both contenders now append additively to the spool
    // and both consents survive.
    const wedged = spawnLedgerWorker(home, { LEDGER_WEDGED_HOLDER: '1' });
    try {
      await waitForLedgerClaim(home, 'wedged holder');
      await Promise.all([contendOneAppend(home, 'degraded-a'), contendOneAppend(home, 'degraded-b')]);
      const ids = readConsentEvents()
        .map((event) => event.sessionId)
        .sort((a, b) => a.localeCompare(b));
      assert.deepEqual(
        ids,
        ['worker-degraded-a-0', 'worker-degraded-b-0'],
        'both degraded consents survive the concurrent spool appends',
      );
    } finally {
      wedged.kill();
    }
  }),
);

test(
  'a torn spool tail never eats the next committed append, and a lost trailing newline never hides the last complete line (round-7 finding 1)',
  withLedgerHome(async (home) => {
    const { dir, spool, lockRoot } = ledgerSpoolPaths(home);
    // Deterministic degradation (the round-3 unhostable-tree shape): a
    // regular FILE where the lock root belongs makes every acquisition
    // throw, so the append takes the additive-spool path with no wedge
    // and no timing.
    const degrade = (): void => writeFileSync(lockRoot, 'not-a-directory');
    const restore = (): void => rmSync(lockRoot, { force: true });

    // The torn tail: one good line, then a mid-JSON fragment with no
    // trailing newline (what a disk-full clamp or a crash mid-append
    // leaves). Pre-fix, the next degraded append glued onto the fragment
    // and the committed event was invisible before AND after every
    // compaction (the seats' organic EFBIG chain).
    writeFileSync(
      spool,
      JSON.stringify(baseEvent({ sessionId: 'pre-torn', argsHash: 'h-pre' })) + '\n{"sessionId":"torn-frag',
    );
    degrade();
    appendConsentEvent(baseEvent({ sessionId: 'after-torn', argsHash: 'h-after' }));
    restore();
    let ids = readConsentEvents().map((event) => event.sessionId);
    assert.ok(ids.includes('pre-torn'), 'the pre-torn lines stay visible');
    assert.ok(ids.includes('after-torn'), 'the new committed line is visible — it did not glue onto the fragment');

    // The lost-newline tail: a COMPLETE line whose trailing newline was
    // the byte a short write dropped. Pre-fix, the next append glued BOTH
    // events into one unparseable line — retroactively hiding the
    // previously-visible one. The fragment line above stays in the file
    // so the compaction leg also proves its raw preservation.
    writeFileSync(
      spool,
      '{"sessionId":"torn-frag"\n' + JSON.stringify(baseEvent({ sessionId: 'complete-line', argsHash: 'h-complete' })),
    );
    degrade();
    appendConsentEvent(baseEvent({ sessionId: 'next-line', argsHash: 'h-next' }));
    restore();
    ids = readConsentEvents().map((event) => event.sessionId);
    assert.ok(ids.includes('complete-line'), 'the previously-visible complete line stays visible');
    assert.ok(ids.includes('next-line'), 'the new committed line is visible');

    // The compaction keeps every committed line visible and preserves the
    // fragment raw.
    appendConsentEvent(baseEvent({ sessionId: 'compactor', argsHash: 'h-comp' }));
    ids = readConsentEvents().map((event) => event.sessionId);
    assert.ok(
      ids.includes('complete-line') && ids.includes('next-line') && ids.includes('compactor'),
      'the folded view keeps every committed line visible',
    );
    const store = JSON.parse(readFileSync(join(dir, 'approval-consents.json'), 'utf8')) as unknown[];
    assert.ok(
      store.some((entry) => typeof entry === 'string' && entry.includes('torn-frag')),
      'the torn fragment is preserved raw in the store',
    );
  }),
);

test(
  'a taken compaction sidecar is visible to the merged reader and carries tier inheritance (round-7 finding 2)',
  withLedgerHome(async (home) => {
    const dir = join(home, '.config', 'huaweicloud');
    stageStore(home, JSON.stringify([baseEvent({ sessionId: 'store-seed', argsHash: 'h-store' })]));
    // The window both seats measured: takeSpool has renamed the spool away
    // and the main write has failed or crashed — the ONLY copy of the
    // original lives in the .taken-* sidecar. Pre-fix the reader saw the
    // store + the spool path only, so the committed event was invisible
    // for the window's whole duration (seconds-wide on a big store), and
    // a degraded tier-inheritance reuse re-recorded a terminal original as
    // posture — permanently.
    writeFileSync(
      join(dir, 'approval-consents.json.spool.jsonl.taken-12340000-0000-4000-8000-000000000000'),
      JSON.stringify(baseEvent({ sessionId: 'ses-window', argsHash: 'h-win', evidence: 'terminal' })) + '\n',
    );
    const view = readConsentEvents();
    assert.ok(
      view.some((event) => event.sessionId === 'ses-window' && event.evidence === 'terminal'),
      'a taken-resident event is visible to the merged reader',
    );

    // The graded consequence: a degraded reuse of the taken-resident
    // original must inherit its tier, not record a fresh posture.
    writeFileSync(join(dir, 'approval-consents-lock'), 'not-a-directory');
    recordAskModeConsent({
      sessionId: 'ses-window',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-win',
      outcome: 'granted',
    });
    rmSync(join(dir, 'approval-consents-lock'), { force: true });
    const rows = readConsentEvents()
      .filter((event) => event.sessionId === 'ses-window')
      .map((event) => event.evidence);
    assert.deepEqual(
      rows.sort((a, b) => a.localeCompare(b)),
      ['terminal', 'terminal'],
      'the reuse inherited the taken-resident original tier — no posture downgrade',
    );
  }),
);

test(
  'a taken file the compaction cannot read is never deleted: the fold failure keeps its bytes (round-7 finding 3)',
  withLedgerHome(async (home) => {
    const dir = join(home, '.config', 'huaweicloud');
    const unreadableTaken = join(dir, 'approval-consents.json.spool.jsonl.taken-12350000-0000-4000-8000-000000000000');
    const spool = join(dir, 'approval-consents.json.spool.jsonl');
    mkdirSync(dir, { recursive: true });
    // A read failure the fold will hit: a taken file with its read bits
    // stripped — readFileSync throws EACCES, the same catch path as EMFILE,
    // EIO, and the measured ERR_STRING_TOO_LONG on a >512MiB spool, while
    // rmSync CAN still delete it (unlink needs the directory's write bit,
    // not the file's) — exactly the pre-fix shape, where the compaction
    // removed every taken file after its main write and silently dropped
    // every consent line it carried.
    writeFileSync(unreadableTaken, JSON.stringify(baseEvent({ sessionId: 'taken-kept', argsHash: 'h-taken' })) + '\n', {
      mode: 0o600,
    });
    chmodSync(unreadableTaken, 0o000);
    writeFileSync(spool, JSON.stringify(baseEvent({ sessionId: 'spool-kept', argsHash: 'h-sp' })) + '\n');

    // A real locked append: the readable spool must fold and land, the
    // unreadable taken file must survive the compaction with its bytes.
    appendConsentEvent(baseEvent({ sessionId: 'compactor', argsHash: 'h-comp' }));
    const landed = new Set(readConsentEvents().map((event) => event.sessionId));
    assert.ok(landed.has('spool-kept'), 'the readable spool folded into the store');
    assert.ok(
      landed.has('compactor'),
      "the compaction's own event landed — the fold failure did not hold the main write hostage",
    );
    assert.ok(
      existsSync(unreadableTaken),
      'the unreadable taken file survived with its bytes — evidence is never deleted on a read failure',
    );
    assert.ok(!existsSync(spool), 'the successfully folded spool was still removed');
    // The bytes are intact under the 000 mode: restore readability and
    // confirm the line is still exactly what was staged.
    chmodSync(unreadableTaken, 0o600);
    const salvaged = readFileSync(unreadableTaken, 'utf8');
    assert.ok(salvaged.includes('taken-kept'), 'the kept file still carries its consent line verbatim');
  }),
);

test(
  'the inherited tier is the earliest granted original by chronology, in every file and name order (round-8 finding 1)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    // Two compaction sidecars whose names differ only in the pid+uuid part
    // — in production that part is random, so any pin that depends on it
    // is a pin on a coin flip. The recovery state: the terminal ORIGINAL
    // on a key, plus a mis-recorded posture COPY (born when a transient
    // read failure hid the original — always the NEWER row by
    // construction), held across the store, the spool, and the two
    // sidecars in every combination. Pre-fix, the resolution took the
    // LAST granted row in fold order, so whichever sidecar name-sorted
    // last decided the tier (both seats: the controlled pair flipped
    // terminal/posture on the name order alone; the real API downgraded
    // on half its runs; the organic chain mis-inherited
    // deterministically). The resolution must pick the EARLIEST granted
    // row on the key by grantedAt, regardless of which file holds it —
    // these cases all use DISTINCT stamps (the equal-stamp boundary is
    // the round-9 pin below).
    const takenFirst = orderTakenFirst(paths.dir);
    const takenLast = orderTakenLast(paths.dir);
    const expectOriginal = (argsHash: string, stage: (write: (path: string, contents: string) => void) => void): void =>
      expectOriginalTier(
        home,
        paths,
        argsHash,
        stage,
        "the reuse inherited the ORIGINAL's tier, not the fold order's pick",
      );
    const key = (i: number): string => `h-order-${i}`;
    // Two taken files, both name orders: the original in the
    // first-sorting sidecar with the copy last (pre-fix: posture), and the
    // mirror (pre-fix: terminal — must stay terminal).
    expectOriginal(key(1), (write) => {
      write(takenFirst, orderLine(key(1), 'terminal', 1_000));
      write(takenLast, orderLine(key(1), 'posture', 2_000));
    });
    expectOriginal(key(2), (write) => {
      write(takenFirst, orderLine(key(2), 'posture', 2_000));
      write(takenLast, orderLine(key(2), 'terminal', 1_000));
    });
    // Spool vs taken: the original taken-resident, the copy spool-resident.
    expectOriginal(key(3), (write) => {
      write(paths.spool, orderLine(key(3), 'posture', 2_000));
      write(takenFirst, orderLine(key(3), 'terminal', 1_000));
    });
    // Store vs taken, both directions: the original compacted into the
    // store with the copy taken-resident (pre-fix: posture — the taken
    // class out-weighed the store's original), and the copy in the store
    // with the original taken-resident.
    expectOriginal(key(4), (write) => {
      stageStore(home, JSON.stringify([JSON.parse(orderLine(key(4), 'terminal', 1_000))]));
      write(takenLast, orderLine(key(4), 'posture', 2_000));
    });
    expectOriginal(key(5), (write) => {
      stageStore(home, JSON.stringify([JSON.parse(orderLine(key(5), 'posture', 2_000))]));
      write(takenLast, orderLine(key(5), 'terminal', 1_000));
    });
    // Store-only, NON-chronological row order (the post-recovery store
    // shape): the copy lands ABOVE the original it was folded ahead of —
    // pre-fix the backwards scan took the copy (the r8 seat's b4 cell).
    expectOriginal(key(6), (write) => {
      stageStore(
        home,
        JSON.stringify([
          JSON.parse(orderLine(key(6), 'posture', 2_000)),
          JSON.parse(orderLine(key(6), 'terminal', 1_000)),
        ]),
      );
      void write;
    });
  }),
);

test(
  'an exact grantedAt tie resolves to the WEAKEST tier present, never by file host or fold order (rounds 9-10)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    // The round-8 fix's boundary case, found by BOTH r9 seats: the r8
    // resolution's strict '<' kept the FIRST row in merged-array order at
    // an equal grantedAt — and array order is fold order, so a
    // same-millisecond failure-born posture copy won the tie whenever its
    // host name-sorted or folded first. The round-9 fix made the tie
    // content-based (tier precedence) but strongest-wins — and round 10,
    // finding 1 (both seats) falsified the DIRECTION: strongest-wins is
    // an UPGRADE path (a posture original with a stronger-tier same-ms
    // copy re-recorded elicitation/terminal over it, 10/10 in three
    // stagings), the exact sentence the plan forbids ("inherits the
    // evidence tier of the original event it reuses and never upgrades
    // it"). At an exact cross-tier tie chronology cannot name the
    // original, so the only plan-conforming tiebreak is the SAFE
    // direction: the WEAKEST tier present. The honest cost this pin
    // encodes: the r9 cell (a terminal original beside a posture copy at
    // the same stamp) now records posture — a rare mis-grade DOWN, never
    // a fabricated upgrade.
    const takenFirst = orderTakenFirst(paths.dir);
    const takenLast = orderTakenLast(paths.dir);
    const T = 1_500; // the EXACT collision: both rows carry the same grantedAt
    const expectWeakest = (
      argsHash: string,
      stage: (write: (path: string, contents: string) => void) => void,
    ): void => {
      const { label, tier } = recordReuseTier(home, paths, argsHash, stage);
      assert.equal(
        tier,
        'posture',
        `${label}: at an exact cross-tier tie the WEAKEST tier present wins — never an upgrade`,
      );
    };
    const key = (i: number): string => `h-tie-${i}`;
    // The r9 cell set, re-derived under weakest-wins: a terminal ORIGINAL
    // beside a posture copy at the same stamp — both taken name orders
    // (the production randomUUID coin flip), store-vs-taken both
    // directions, spool-vs-taken, and the store-only copy-above-original
    // cell. Every one now records posture: the mis-grade DOWN is the
    // sanctioned trade, stably across name orders and fold orders.
    expectWeakest(key(1), (write) => {
      write(takenFirst, orderLine(key(1), 'terminal', T));
      write(takenLast, orderLine(key(1), 'posture', T));
    });
    expectWeakest(key(2), (write) => {
      write(takenFirst, orderLine(key(2), 'posture', T));
      write(takenLast, orderLine(key(2), 'terminal', T));
    });
    expectWeakest(key(3), (write) => {
      stageStore(home, JSON.stringify([JSON.parse(orderLine(key(3), 'posture', T))]));
      write(takenLast, orderLine(key(3), 'terminal', T));
    });
    expectWeakest(key(4), (write) => {
      stageStore(home, JSON.stringify([JSON.parse(orderLine(key(4), 'terminal', T))]));
      write(takenLast, orderLine(key(4), 'posture', T));
    });
    expectWeakest(key(5), (write) => {
      write(paths.spool, orderLine(key(5), 'posture', T));
      write(takenFirst, orderLine(key(5), 'terminal', T));
    });
    expectWeakest(key(6), (write) => {
      stageStore(
        home,
        JSON.stringify([JSON.parse(orderLine(key(6), 'posture', T)), JSON.parse(orderLine(key(6), 'terminal', T))]),
      );
      void write;
    });
    // The upgrade direction round 10 found (both seats): a posture
    // ORIGINAL with a STRONGER copy at the same stamp — pre-fix recorded
    // the copy's tier (elicitation 10/10, terminal 10/10, all six host
    // cells, the locked path permanent). Weakest-wins keeps the
    // original's grade down: posture, never an upgrade.
    expectWeakest(key(8), (write) => {
      write(takenFirst, orderLine(key(8), 'posture', T));
      write(takenLast, orderLine(key(8), 'terminal', T));
    });
    expectWeakest(key(9), (write) => {
      write(takenFirst, orderLine(key(9), 'posture', T));
      write(takenLast, orderLine(key(9), 'elicitation', T));
    });
    // The all-three-tiers tie: the weakest tier present (posture) wins
    // across every permutation.
    expectWeakest(key(10), (write) => {
      write(takenFirst, orderLine(key(10), 'posture', T));
      write(takenLast, orderLine(key(10), 'elicitation', T));
      stageStore(home, JSON.stringify([JSON.parse(orderLine(key(10), 'terminal', T))]));
    });
    // A tie with EQUAL tiers is immaterial: both rows carry posture, and
    // the resolution must still resolve (posture), never fall through to
    // the caller's elicitation override.
    const { label, tier } = recordReuseTier(home, paths, key(7), (write) => {
      write(takenFirst, orderLine(key(7), 'posture', T));
      write(takenLast, orderLine(key(7), 'posture', T));
    });
    assert.equal(tier, 'posture', `${label}: an equal-tier tie keeps the resolved tier, not the caller's override`);
  }),
);

test(
  'the delivery annotation never lands on another arrival row: a spool/taken-resident newest row skips entirely (round-11 finding 1)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    // Both r11 seats found the same sequential corruption: the annotate
    // scanned the MAIN STORE ONLY for the newest granted row on the key,
    // so when THIS dispatch's own arrival degraded to the spool (or lived
    // in a taken sidecar — the round-7 recovery state) it found an
    // EARLIER arrival's store row and stamped this call's outcome over
    // it: a delivered row rewritten to failed, the failed call's own row
    // datumless, deterministic in the ~3s healthy-section band the
    // round-6 cap was sized for — falsifying the header's "left alone"
    // promise. The guard: the annotate resolves the newest granted row on
    // the key through the MERGED world (store + spool + taken) and skips
    // entirely unless that row is the store row this dispatch's own
    // arrival wrote. Never another arrival's row; ties skip (an equal
    // stamp cannot prove ownership).
    const takenFile = join(paths.dir, 'approval-consents.json.spool.jsonl.taken-12390000-0000-4000-8000-000000000000');
    // The arrival stamp the gate's ask branch returns (round 12, finding 2):
    // ownership is proven by the stamp — the row this dispatch's own arrival
    // wrote — never by absence.
    const annotateKey = (hash: string, arrivalStamp?: number): void => {
      annotateDispatchOutcome({
        sessionId: 'ses-annotate',
        tool: 'huaweicloud_run_approved_command',
        argsHash: hash,
        arrivalStamp,
        outcomeDetail: 'failed',
      });
    };
    const detailOf = (hash: string, stamp: number): ConsentDeliveryOutcome | 'absent' | undefined => {
      const row = readConsentEvents().find((event) => event.argsHash === hash && event.grantedAt === stamp);
      return row === undefined ? undefined : (row.outcomeDetail ?? 'absent');
    };
    const stageKey = (hash: string): void => {
      rmSync(takenFile, { force: true });
      rmSync(paths.spool, { force: true });
      stageStore(home, '[]');
    };
    const line = (hash: string, grantedAt: number): string =>
      JSON.stringify(baseEvent({ sessionId: 'ses-annotate', argsHash: hash, grantedAt })) + '\n';

    // Cell 1 — the taken-resident newest arrival (the round-7 recovery
    // state the ledger deliberately keeps visible): the earlier store row
    // was DELIVERED, this call's arrival is taken-resident, this call
    // FAILED. Pre-fix: the store row flipped to failed. Post-fix: skip —
    // the delivered row keeps its own call's outcome, the taken row stays
    // unannotated.
    stageKey('h-an-taken');
    stageStore(home, JSON.stringify([{ ...JSON.parse(line('h-an-taken', 1_000)), outcomeDetail: 'delivered' }]));
    writeFileSync(takenFile, line('h-an-taken', 2_000));
    annotateKey('h-an-taken', 2_000);
    assert.equal(
      detailOf('h-an-taken', 1_000),
      'delivered',
      'taken cell: the earlier delivered row keeps its own outcome',
    );
    assert.equal(detailOf('h-an-taken', 2_000), 'absent', 'taken cell: this degraded arrival stays unannotated');

    // Cell 2 — the spool-resident newest arrival (the degraded-dispatch
    // shape): same skip.
    stageKey('h-an-spool');
    stageStore(home, JSON.stringify([{ ...JSON.parse(line('h-an-spool', 1_000)), outcomeDetail: 'delivered' }]));
    writeFileSync(paths.spool, line('h-an-spool', 2_000));
    annotateKey('h-an-spool', 2_000);
    assert.equal(
      detailOf('h-an-spool', 1_000),
      'delivered',
      'spool cell: the earlier delivered row keeps its own outcome',
    );
    assert.equal(detailOf('h-an-spool', 2_000), 'absent', 'spool cell: this degraded arrival stays unannotated');

    // Cell 3 — the guard must not OVER-skip: an earlier degraded arrival
    // sits in the spool with an OLDER stamp; this dispatch's own arrival
    // landed in the store. The annotate proceeds on the store row — the
    // newest granted row on the key is this call's own, store-resident.
    stageKey('h-an-normal');
    writeFileSync(paths.spool, line('h-an-normal', 900));
    stageStore(home, JSON.stringify([JSON.parse(line('h-an-normal', 1_000))]));
    annotateKey('h-an-normal', 1_000);
    assert.equal(
      detailOf('h-an-normal', 1_000),
      'failed',
      "normal cell: the annotate lands on this call's own store row",
    );
    assert.equal(detailOf('h-an-normal', 900), 'absent', 'normal cell: the earlier degraded row is untouched');

    // Cell 4 — the tie: a taken-resident row at the SAME stamp as the
    // store row cannot prove the store row is this dispatch's arrival —
    // skip (never another arrival's row, even at ambiguity).
    stageKey('h-an-tie');
    stageStore(home, JSON.stringify([{ ...JSON.parse(line('h-an-tie', 1_000)), outcomeDetail: 'delivered' }]));
    writeFileSync(takenFile, line('h-an-tie', 1_000));
    annotateKey('h-an-tie', 1_000);
    assert.equal(detailOf('h-an-tie', 1_000), 'delivered', 'tie cell: an ambiguous newest row is left alone');
  }),
);

test(
  'a dropped arrival append is never annotated over an earlier row, and the annotate never writes the store (round-12 findings 2 and 4)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const store = join(paths.dir, 'approval-consents.json');
    const key = 'h-r12-dropped';
    const annotate = (arrivalStamp?: number, arrivalSeq?: number): void => {
      annotateDispatchOutcome({
        sessionId: 'ses-r12',
        tool: 'huaweicloud_run_approved_command',
        argsHash: key,
        arrivalStamp,
        arrivalSeq,
        outcomeDetail: 'failed',
      });
    };
    const rawBytes = (): string => readFileSync(store, 'utf8');

    // An earlier identical call on the key: it DELIVERED, and its row is
    // committed in the store.
    const earlierStamp = 1_700_000_000_000;
    // The earlier row is on THIS key — same session, tool, and argsHash the
    // annotate targets (the pin's first draft staged orderLine's ses-order
    // session id, which never matched the annotate's key and made the pin
    // vacuous — the round-12 mutation check caught it).
    stageStore(
      home,
      JSON.stringify([
        {
          sessionId: 'ses-r12',
          tool: 'huaweicloud_run_approved_command',
          argsHash: key,
          outcome: 'granted',
          grantedAt: earlierStamp,
          scope: 'once',
          evidence: 'posture',
          arrivalSeq: 0,
          outcomeDetail: 'delivered',
        },
      ]),
    );
    const before = rawBytes();

    // This dispatch's arrival append dies in lockedAppend's best-effort
    // catch (its tmp path is a directory; the production shapes are
    // ENOSPC/EIO/EACCES in the same catch): the stamp recordAskModeConsent
    // returns matches no row anywhere. Pre-fix (round 12, finding 2, both
    // seats' shape), the store-only "newest granted row" target then
    // rewrote the EARLIER call's delivered row with this call's failed —
    // absence proved ownership. Now: no row with the arrival's stamp, no
    // annotate, ever.
    mkdirSync(`${store}.${process.pid}.tmp`, { recursive: true });
    const dropped = recordAskModeConsent({
      sessionId: 'ses-r12',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    rmSync(`${store}.${process.pid}.tmp`, { recursive: true, force: true });
    annotate(dropped.grantedAt, dropped.arrivalSeq);
    assert.equal(
      rawBytes(),
      before,
      'the dropped arrival leaves the earlier row byte-identical — the annotate rewrote nothing',
    );
    let rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 1, 'the dropped arrival contributes no visible row');
    assert.equal(rows[0]!.outcomeDetail, 'delivered', 'the earlier row keeps its own delivered datum');
    // And a recorder call with NO stamp at all is a no-op by contract.
    annotate(undefined);
    assert.equal(rawBytes(), before, 'a stamp-less annotate writes nothing anywhere');

    // The annotate's write is the additive outcome side channel, never the
    // store (round 12, finding 4): a normal annotate that LANDS must leave
    // the store bytes untouched too — a heartbeat-less holder deposed past
    // the 1s takeover window commits its lockedAppend rename mid-annotate,
    // and the pre-fix whole-file annotate erased that commit (the round-6
    // erasure class through the r10 writer). A lockless additive annotate
    // cannot erase anything, structurally.
    const second = recordAskModeConsent({
      sessionId: 'ses-r12',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    const beforeLanding = rawBytes();
    annotate(second.grantedAt, second.arrivalSeq);
    assert.equal(rawBytes(), beforeLanding, 'a LANDING annotate still writes only the side channel, never the store');
    rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 2, 'the second arrival is its own row');
    assert.equal(rows[1]!.outcomeDetail, 'failed', 'the side channel carries the datum into the merged view');
    assert.equal(rows[0]!.outcomeDetail, 'delivered', 'the earlier row is untouched');
  }),
);

test(
  'the outcome fold binds to the STORE-resident row only: a same-ms degraded twin never receives a line (round-13 finding 2)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    // The r11/r12 annotate guard refuses to write a line when the arrival
    // degraded — but the r12 reader's fold attached each line to the LAST
    // view row matching key+stamp across ALL sources, so a degraded twin
    // sharing the arrival's exact millisecond received dispatch A's
    // outcome at read time (A1's twin probe: truth A=failed B=delivered,
    // view A=(absent) B=failed — the degraded row carrying a datum the
    // guard refuses to write). The fold now mirrors the guard's own
    // semantics: a line binds to a STORE-resident row at that key+stamp or
    // nothing at all — the degraded twin stays datumless whatever
    // interleaving produced it.
    const T = 1_700_000_000_000; // the same-ms collision stamp
    // One key PER CELL (round 14 hygiene): the annotate's outcome lines
    // accumulate in the shared side channel, and a seq-keyed line binds to
    // the exact row it names — so a shared key lets one cell's stale line
    // bind a later cell's row. The cells are independent cases; their keys
    // must be too.
    const key = (i: number): string => `h-twin13-${i}`;
    const annotate = (
      argsHash: string,
      arrivalStamp: number,
      detail: 'failed' | 'delivered',
      arrivalSeq?: number,
    ): void => {
      annotateDispatchOutcome({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash,
        arrivalStamp,
        arrivalSeq,
        outcomeDetail: detail,
      });
    };

    // Cell 1 — the ordering-1 interleave (A1's twin probe): dispatch A
    // locked and annotated FIRST, then dispatch B's degraded twin appears
    // in the spool at the same stamp. The fold must keep A's datum on A's
    // row; B stays unannotated.
    {
      const cellKey = key(1);
      const storeRow = baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 0 });
      stageStore(home, JSON.stringify([storeRow]));
      annotate(cellKey, T, 'failed'); // the line is written (A's row is store-resident, no twin yet)
      writeFileSync(
        paths.spool,
        JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 1 })) + '\n',
      );
      const rows = readConsentEvents().filter((event) => event.argsHash === cellKey);
      assert.equal(rows.length, 2, 'twin cell 1: both rows are visible');
      assert.equal(rows[0]!.outcomeDetail, 'failed', 'twin cell 1: the store row keeps its own datum');
      assert.equal(rows[1]!.outcomeDetail, undefined, 'twin cell 1: the degraded twin never receives the line');
    }

    // Cell 2 — the taken-resident twin (the crash-recovery duplicate): the
    // line is written before the twin exists, then a .taken-* duplicate of
    // the row appears at the same stamp. The store row keeps the datum;
    // the taken twin stays unannotated (pre-fix, the fold's last-row rule
    // handed the line to the taken row).
    {
      const takenFile = join(
        paths.dir,
        'approval-consents.json.spool.jsonl.taken-13130000-0000-4000-8000-000000000000',
      );
      const cellKey = key(2);
      const storeRow = baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 0 });
      rmSync(paths.spool, { force: true });
      stageStore(home, JSON.stringify([storeRow]));
      annotate(cellKey, T, 'delivered');
      writeFileSync(
        takenFile,
        JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 1 })) + '\n',
      );
      const rows = readConsentEvents().filter((event) => event.argsHash === cellKey);
      assert.equal(rows.length, 2, 'twin cell 2: both rows are visible');
      assert.equal(rows[0]!.outcomeDetail, 'delivered', 'twin cell 2: the store row keeps its own datum');
      assert.equal(rows[1]!.outcomeDetail, undefined, 'twin cell 2: the taken twin never receives the line');
    }

    // Cell 3 — the store-only same-ms rule through the fold: two
    // STORE-resident rows at the same stamp (the r11 samems shape); the
    // line binds to the LAST store row at that stamp, and the earlier row
    // keeps whatever it carries.
    {
      const cellKey = key(3);
      const rowA = {
        ...baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 0 }),
        outcomeDetail: 'failed' as const,
      };
      const rowB = baseEvent({ sessionId: 'ses', argsHash: cellKey, grantedAt: T, arrivalSeq: 1 });
      rmSync(paths.spool, { force: true });
      stageStore(home, JSON.stringify([rowA, rowB]));
      // Round 15, finding 2: two store rows share the stamp — a stamp-only
      // call is AMBIGUOUS and skips; the dispatch's own identity (rowB's
      // seq) binds the line to the exact row it wrote.
      annotate(cellKey, T, 'delivered', 1);
      const rows = readConsentEvents().filter((event) => event.argsHash === cellKey);
      assert.equal(rows[0]!.outcomeDetail, 'failed', 'samems cell: the earlier store row keeps its own datum');
      assert.equal(rows[1]!.outcomeDetail, 'delivered', 'samems cell: the threaded identity binds the exact row');
      // And the stamp-only call on a fresh ambiguous pair skips — never
      // positional (the r15 doctrine): a fresh key, two same-stamp rows, no
      // threaded identity — the ambiguity is detected, not resolved.
      const skipKey = key(4);
      const skipRowA = {
        ...baseEvent({ sessionId: 'ses', argsHash: skipKey, grantedAt: T, arrivalSeq: 0 }),
        outcomeDetail: 'failed' as const,
      };
      const skipRowB = baseEvent({ sessionId: 'ses', argsHash: skipKey, grantedAt: T, arrivalSeq: 1 });
      rmSync(paths.spool, { force: true });
      stageStore(home, JSON.stringify([skipRowA, skipRowB]));
      annotate(skipKey, T, 'delivered');
      const rows2 = readConsentEvents().filter((event) => event.argsHash === skipKey);
      assert.equal(
        rows2[0]!.outcomeDetail,
        'failed',
        'samems skip cell: an ambiguous stamp-only call never overwrites the earlier row',
      );
      assert.equal(rows2[1]!.outcomeDetail, undefined, 'samems skip cell: the ambiguous call binds nothing');
    }
  }),
);

test(
  'the tier chronology keys the arrival sequence, so a backward clock step never names the copy the original (round-13 finding 4)',
  withLedgerHome(async (home) => {
    // A1's skew probe: a NTP/VM-restore step gives a later-written
    // failure-born copy a SMALLER grantedAt, and grantedAt-only chronology
    // named it the original — the fabricated upgrade the never-upgrade
    // rule exists to prevent, with no tiebreak firing (the stamps differ).
    // The counter is assigned per append from the high-water file, so it
    // tracks real arrival order whatever the wall clock did; the resolution
    // orders by (arrivalSeq, grantedAt).
    const key = 'h-skew13';
    // The skew staging + reuse rides the shared helper (the r13 pin's
    // store predates the counter file, so the file is removed on purpose).
    let rows = stageSkewPairAndReuse(home, key, false);
    assert.equal(
      rows.at(-1)!.evidence,
      'posture',
      "the seq named the true original: the reuse inherits posture, never the skewed copy's terminal",
    );
    // Control: the copy newer in BOTH seq and stamp — chronology agrees
    // either way, and the verdict must not move.
    stageStore(
      home,
      JSON.stringify([
        baseEvent({ sessionId: 'ses', argsHash: key, evidence: 'posture', grantedAt: 5_000, arrivalSeq: 0 }),
        baseEvent({ sessionId: 'ses', argsHash: key, evidence: 'terminal', grantedAt: 6_000, arrivalSeq: 1 }),
      ]),
    );
    recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.at(-1)!.evidence, 'posture', 'control: the healthy chain keeps its verdict');
    // And the counter is live on real rows: two sequential arrivals get
    // increasing seqs even though this test freezes nothing.
    stageStore(home, '[]');
    const first = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    const second = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.ok(rows[0]!.arrivalSeq < rows[1]!.arrivalSeq, 'real arrivals carry increasing seqs');
    assert.notEqual(first.grantedAt, second.grantedAt, 'distinct arrivals keep distinct stamps');
    assert.ok(first.arrivalSeq < second.arrivalSeq, 'the identity threads the seq the ledger assigned');
  }),
);

test(
  'the outcome fold is one pass: 8k rows + 8k lines read in linear time with every datum attached (round-13 finding 1)',
  withLedgerHome(async (home) => {
    // Both r13 seats quantified the quadratic independently: the fold
    // scanned the merged view FROM THE END for every line, and the read
    // runs inside the lock section of every ask-mode arrival's tier
    // resolution — 5.9-7.0s at 20k dispatches, crossing the 3s lock cap at
    // ~15k and the 5s caller bar at ~17k, and pushing concurrent arrivals
    // past the cap so their degraded rows' outcomes were never recorded.
    // The fold is now O(store + lines) — one map pass over the store rows,
    // then one pass over the lines. The bound is coarse on purpose: the
    // linear fold measures ~55ms at 8k+8k here and the quadratic ~850ms+;
    // 400ms separates them on any host this battery runs on, and the
    // correctness half (every line attaches) is the primary assertion.
    const dir = join(home, '.config', 'huaweicloud');
    const N = 8_000;
    const rows: ConsentEvent[] = [];
    const lines: string[] = [];
    for (let i = 0; i < N; i += 1) {
      rows.push(baseEvent({ sessionId: 'ses', argsHash: `k-${i}`, grantedAt: 1_700_000_000_000 + i, arrivalSeq: i }));
      lines.push(
        JSON.stringify({
          sessionId: 'ses',
          tool: 'huaweicloud_run_approved_command',
          argsHash: `k-${i}`,
          grantedAt: 1_700_000_000_000 + i,
          outcomeDetail: 'failed',
        }),
      );
    }
    stageStore(home, JSON.stringify(rows));
    writeFileSync(join(dir, 'approval-consents.json.outcomes.jsonl'), lines.join('\n') + '\n');
    const started = Date.now();
    const view = readConsentEvents();
    const elapsed = Date.now() - started;
    assert.equal(view.length, N, 'every staged row is visible');
    assert.equal(
      view.filter((event) => event.outcomeDetail === 'failed').length,
      N,
      'every outcome line attaches to its row',
    );
    assert.ok(
      elapsed < 400,
      `the one-pass fold stays linear (8k+8k read took ${elapsed}ms; the quadratic fold measured 850ms+)`,
    );
  }),
);

test(
  'the arrivalSeq counter floors at the store and fails newest, never oldest (round-14 finding 1)',
  withLedgerHome(async (home) => {
    // Both seats: the counter's failure floor was fail-open. A missing
    // file over a NON-empty store stamped the next arrival 0 — colliding
    // with the real original's seq, so a later-written stronger copy won
    // chronology (the fabricated upgrade, no clock skew needed); an
    // unreadable (chmod-000) file stamped -1 while the store write
    // SUCCEEDED — a permanent first-sorting row; a non-numeric file
    // rewound the counter under the store and serialized writers re-took
    // 0,1,2. The counter now floors at the store (seed from the merged
    // view's max whenever the file read fails or yields <= store max,
    // never writing a value below it) and a row whose seq could not be
    // determined sorts NEWEST, never oldest.
    const dir = join(home, '.config', 'huaweicloud');
    const seqFile = join(dir, 'approval-consents.seq');
    const key = 'h-seq-floor';
    const row = (evidence: ConsentEvidence, grantedAt: number, arrivalSeq: number): string =>
      JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: key, evidence, grantedAt, arrivalSeq }));

    // Cell 1 — the missing-file-over-non-empty-store shape (A2 1a): the
    // shared skew staging with the seq file ABSENT over the non-empty
    // store. The next append must seed from the store's max (never stamp
    // 0 over a non-empty store — the A2 upgrade shape's root).
    let rows = stageSkewPairAndReuse(home, key, false);
    assert.equal(rows.length, 3, 'cell 1: the append landed');
    assert.ok(rows[2]!.arrivalSeq > 1, `cell 1: the missing file seeded from the store (seq ${rows[2]!.arrivalSeq})`);
    assert.equal(rows.at(-1)!.evidence, 'posture', 'cell 1: the original kept chronology — no fabricated upgrade');

    // Cell 2 — the unreadable-file shape (A2 1b): chmod-000 the counter;
    // the append SUCCEEDS (the store is writable) and the row must sort
    // NEWEST, never -1, and the next append recovers above the store.
    stageStore(home, `[${row('posture', 5_000, 0)},${row('terminal', 4_000, 1)}]`);
    writeFileSync(seqFile, '1\n');
    chmodSync(seqFile, 0o000);
    recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 3, 'cell 2: the store write succeeded while the counter read failed');
    assert.ok(
      rows[2]!.arrivalSeq > 1,
      `cell 2: the unreadable counter failed NEWEST (seq ${rows[2]!.arrivalSeq}), never -1`,
    );
    assert.equal(rows.at(-1)!.evidence, 'posture', 'cell 2: chronology held');
    chmodSync(seqFile, 0o600);

    // Cell 3 — the non-numeric-file shape (A2 1c): the counter rewinds to
    // 0 under a seq-2 store unless the store floors it; three serialized
    // writers must never re-take an existing seq.
    stageStore(home, `[${row('posture', 1, 0)},${row('posture', 2, 1)},${row('posture', 3, 2)}]`);
    writeFileSync(seqFile, 'not-a-number\n');
    for (let i = 0; i < 3; i += 1) {
      recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: key,
        outcome: 'granted',
      });
    }
    rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 6, 'cell 3: three appends landed');
    const seqs = rows.map((event) => event.arrivalSeq).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(
        seqs[i]! > seqs[i - 1]!,
        `cell 3: strictly increasing seqs (got ${JSON.stringify(seqs)}) — the corrupted file did not rewind the counter`,
      );
    }
    // And the recovered high-water is above the store's max: a value
    // below it is never written.
    const written = Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10);
    assert.ok(written >= 5, `cell 3: the counter write-back is monotonic (${written})`);
  }),
);

test(
  'concurrent locked writers never duplicate a seq (round-14 finding 2)',
  withLedgerHome(async (home) => {
    // Both seats: the assignment used to run BEFORE withDepLock on the raw
    // append face — 24 barrier-synchronized writers duplicated 13 seq
    // groups (the "locked writers serialize" comment was mechanically
    // false at the assignment site). The assignment now runs inside the
    // lock body; the degraded path (which cannot hold the lock) remains
    // the recorded duplicate residual. Barrier-synchronized workers drive
    // the raw face through the test file's own worker mode.
    const { spawn } = await import('node:child_process');
    const barrier = join(home, 'go.marker');
    const WORKERS = 12;
    const PER = 5;
    const children = [];
    for (let i = 0; i < WORKERS; i += 1) {
      children.push(
        new Promise<void>((resolve, reject) => {
          const child = spawnLedgerWorker(home, {
            LEDGER_WORKER: `w${i}`,
            LEDGER_PER_WORKER: String(PER),
            LEDGER_BARRIER: barrier,
          });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker w${i} exit ${code}`))));
          child.on('error', reject);
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000)); // all workers spinning on the barrier
    writeFileSync(barrier, 'go');
    await Promise.all(children);
    const rows = readConsentEvents();
    assert.equal(rows.length, WORKERS * PER, `every append landed (${rows.length})`);
    const seqCounts = new Map<number, number>();
    for (const event of rows) seqCounts.set(event.arrivalSeq, (seqCounts.get(event.arrivalSeq) ?? 0) + 1);
    const duplicates = [...seqCounts.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(
      duplicates,
      [],
      `the locked assignment serialized: no duplicate seqs (${duplicates.length} duplicate groups)`,
    );
  }),
);

test(
  'the outcome line survives the compaction: a same-ms degraded twin compacted in BEHIND the annotated row never steals it (round-14 finding 4)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    // A2: the r13 fold keyed the line on key+stamp with no arrival
    // identity, and the compaction always folds spool rows AFTER existing
    // store rows — so the next ordinary append moved a same-ms degraded
    // twin BEHIND the annotated row and the last-index rule handed the
    // line to the twin (the row that annotated lost it). The line now
    // carries the arrival's seq (captured by the annotate from the row
    // its guard verified), so it binds to the EXACT row whatever the
    // compaction did to the order.
    const T = 1_700_000_000_000; // the shared millisecond
    const key = 'h-twin14';
    // Dispatch B: locked, store-resident at T (seq 0), its dispatch
    // returned failed — the annotate writes the line (guard passes: B's
    // row is store-resident, nothing newer outside).
    stageTwinStoreRow(home, key, T);
    annotateDispatchOutcome({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      arrivalStamp: T,
      outcomeDetail: 'failed',
    });
    // Dispatch A: degraded at the same millisecond — its twin (seq 1)
    // lands in the spool, and one ordinary locked append compacts it in
    // BEHIND the annotated row.
    compactTwinInBehind(paths, key, T);
    const rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 2, 'both twin rows are store-resident after the compaction');
    assert.ok(
      rows[0]!.arrivalSeq === 0 && rows[1]!.arrivalSeq === 1,
      'the compaction placed the twin behind the annotated row',
    );
    assert.equal(rows[0]!.outcomeDetail, 'failed', 'the row that annotated keeps its own datum through the compaction');
    assert.equal(rows[1]!.outcomeDetail, undefined, 'the degraded twin never receives the line');
  }),
);

test(
  'the arrivalSeq space is bounded: poisoned rows and files never stall, duplicate, or hide a row (round-15 finding 1)',
  withLedgerHome(async (home) => {
    const dir = join(home, '.config', 'huaweicloud');
    const seqFile = join(dir, 'approval-consents.seq');
    const spool = join(dir, 'approval-consents.json.spool.jsonl');
    const key = 'h-r15-bound';
    const row = (evidence: ConsentEvidence, grantedAt: number, arrivalSeq: number | null, k = key): string =>
      stagedRowJson(evidence, grantedAt, arrivalSeq, k);
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;

    // Cell 1 — the seats' poison shape (both seats, independent staging):
    // a spool line claiming seq MAX_SAFE-1 over a small store. The poison
    // is out of the assignable space: the appends get strictly increasing
    // VALID seqs (the floor counts valid seqs only), no row carries the
    // sentinel, and the reuse keeps posture (the r13 shape at a healthy
    // counter).
    stageStore(home, `[${row('posture', 100, 0, 'h-p1')},${row('posture', 101, 1, 'h-p1')}]`);
    writeFileSync(spool, row('posture', 102, MAX_SAFE - 1, 'h-poison') + '\n');
    const appends: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: 'h-p1',
        outcome: 'granted',
      });
      const rows = readConsentEvents().filter((event) => event.argsHash === 'h-p1');
      appends.push(rows.at(-1)!.arrivalSeq);
    }
    // Relationally asserted (round 15): lastAssignedSeq is a process-global
    // the earlier tests in this file legitimately advance, so the appends
    // may land on a higher lane than the staged 2/3/4 — what the cell pins
    // is the POISON's absence from the floor: strictly increasing (a
    // saturated counter re-takes one value), every seq valid (never the
    // sentinel, never past the assignable space), and the whole lane small
    // (the poison would floor it to ~MAX_SAFE_INTEGER).
    assert.ok(
      appends[0]! < appends[1]! && appends[1]! < appends[2]! && appends.every((seq) => seq < 1_000),
      `cell 1: strictly increasing seqs on a small lane — the poison never floors the counter (got ${JSON.stringify(appends)})`,
    );
    const poisonRow = readConsentEvents().find((event) => event.argsHash === 'h-poison');
    assert.equal(
      poisonRow!.arrivalSeq,
      MAX_SAFE,
      'cell 1: the poison row reads as the sentinel — visible, newest, never a floor',
    );

    // Cell 2 — the forward-corrupted FILE (A1's P5): a file value outside
    // the space is invalid; the parsed store floor repairs it, and the
    // counter recovers monotonically.
    stageStore(
      home,
      `[${row('posture', 100, 0, 'h-p2')},${row('posture', 101, 1, 'h-p2')},${row('posture', 102, 2, 'h-p2')}]`,
    );
    writeFileSync(seqFile, `${MAX_SAFE - 1}\n`);
    recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-p2',
      outcome: 'granted',
    });
    let rows = readConsentEvents().filter((event) => event.argsHash === 'h-p2');
    const repaired = rows.at(-1)!.arrivalSeq;
    assert.ok(
      repaired < MAX_SAFE - 2,
      `cell 2: the corrupted file was repaired to a valid seq — the out-of-range value floored nothing (seq ${repaired})`,
    );
    assert.equal(Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10), repaired, 'cell 2: the file was rewritten');
    recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-p2',
      outcome: 'granted',
    });
    rows = readConsentEvents().filter((event) => event.argsHash === 'h-p2');
    assert.ok(rows.at(-1)!.arrivalSeq > repaired, 'cell 2: the recovered counter advances');

    // Cell 3 — the Infinity shape (A1): a row whose seq overflows to
    // Infinity on parse is VISIBLE (sentinel, newest) — never serialized
    // null, never invisible — and the counter ignores it.
    stageStore(
      home,
      '[{"sessionId":"ses","tool":"huaweicloud_run_approved_command","argsHash":"h-inf","outcome":"granted","grantedAt":1,"scope":"once","evidence":"posture","arrivalSeq":1e999}]',
    );
    const infRows = readConsentEvents().filter((event) => event.argsHash === 'h-inf');
    assert.equal(infRows.length, 1, 'cell 3: the Infinity row stays visible');
    assert.equal(infRows[0]!.arrivalSeq, MAX_SAFE, 'cell 3: it reads as the sentinel');
    recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-inf',
      outcome: 'granted',
    });
    rows = readConsentEvents().filter((event) => event.argsHash === 'h-inf');
    assert.ok(
      rows.at(-1)!.arrivalSeq < 1_000,
      `cell 3: the counter stayed on the small monotonic lane — the Infinity row is not a floor (seq ${rows.at(-1)!.arrivalSeq})`,
    );
    // The tier resolution skips sentinel rows (unknown chronology never
    // names an original): a key with only sentinel rows resolves fresh.
    assert.equal(rows.at(-1)!.evidence, 'posture', 'cell 3: the sentinel row was not an original');
  }),
);

test(
  'the annotate binds the threaded identity, never a positional candidate (round-15 finding 2)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const T = 1_700_000_000_000;
    const key = 'h-r15-capture';
    // The T2 timeline (both seats): dispatch D1's store row (seq 0), the
    // same-ms degraded twin (seq 1) compacts in BEHIND it, and D1's
    // annotate runs LAST. The positional capture used to mint the line
    // carrying the TWIN's seq; the threaded identity binds D1's own row.
    stageTwinStoreRow(home, key, T);
    compactTwinInBehind(paths, key, T);
    // D1's dispatch finishes now: the annotate with the threaded identity.
    annotateDispatchOutcome({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      arrivalStamp: T,
      arrivalSeq: 0,
      outcomeDetail: 'failed',
    });
    const rows = readConsentEvents().filter((event) => event.argsHash === key);
    assert.equal(rows.length, 2, 'both rows are store-resident after the compaction');
    assert.equal(rows[0]!.arrivalSeq, 0, 'the compaction placed the twin behind');
    assert.equal(rows[0]!.outcomeDetail, 'failed', "the threaded identity bound the dispatch's OWN row");
    assert.equal(rows[1]!.outcomeDetail, undefined, 'the degraded twin never receives the line');
  }),
);

// The fast-path probe's preload hook (round 15, finding 4): patch
// fs.readFileSync BEFORE the worker's module graph links — an ESM builtin
// link snapshots the patched export, so every outcomes-file read the
// process performs is counted. Written at runtime into the probe's home;
// no committed .cjs file to lint.
const FS_COUNT_HOOK_SOURCE = [
  "const fs = require('node:fs');",
  'const real = fs.readFileSync;',
  'globalThis.__outcomesReads = 0;',
  'fs.readFileSync = function patchedReadFileSync(path, ...rest) {',
  "  if (String(path).endsWith('.outcomes.jsonl')) globalThis.__outcomesReads += 1;",
  '  return real.call(fs, path, ...rest);',
  '};',
].join('\n');

// Round 15, finding 4 (both seats): the locked path's seq floor is
// PARSED, not scanned. The r14 floor fix read the merged view on EVERY
// append (the seq file "optimization" consulted nothing — "the file is an
// optimization" was false as written), doubling the ask-arrival stall: a
// 1M-row append measured 4.9-10.9s, past the 3s wait cap, so concurrent
// arrivals degraded and their unlocked seq assignments collided. The
// observable: the outcomes file is the ONE file only the merged view reads
// (the parsed floor reads the raw store, the taken spool, and the seq file
// — all of which the locked section already needs). Count its reads in a
// fresh worker process, patched at --require preload time: ONE ask-mode
// arrival with a HEALTHY seq file reads it exactly once (the tier
// resolution) — the r14 scan paid a second read on every append. A
// corrupted file is repaired by the PARSED floor at no extra read, the
// repaired tree is fast again (the scan is a repair path, not a deferral),
// and the DEGRADED path keeps the merged-view scan where it is the only
// floor source left (phase 4: a missing file under an unacquirable lock
// still floors from the store, never rewinds).
test(
  'the locked floor is parsed, not scanned: the outcomes file is read once per arrival, healthy or corrupted (round-15 finding 4)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const key = 'h-r15-fast';
    const outcomes = join(paths.dir, 'approval-consents.json.outcomes.jsonl');
    const seqFile = join(paths.dir, 'approval-consents.seq');
    const countFile = join(home, 'outcomes-reads.txt');
    const hookFile = join(home, 'fs-read-hook.cjs');
    writeFileSync(hookFile, FS_COUNT_HOOK_SOURCE);
    stageStore(home, JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: key, grantedAt: 1_000, arrivalSeq: 0 })]));
    writeFileSync(
      outcomes,
      JSON.stringify({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: key,
        grantedAt: 1_000,
        arrivalSeq: 0,
        outcomeDetail: 'delivered',
      }) + '\n',
    );
    writeFileSync(seqFile, '0\n');
    const probeResult = (): [number, number] => {
      const tokens = readFileSync(countFile, 'utf8').trim().split(/\s+/);
      return [Number(tokens[0] || '0'), Number(tokens[1] || '0')];
    };
    const countReads = (): number => probeResult()[0];
    const probe = (degraded = false): Promise<void> => {
      rmSync(countFile, { force: true });
      return new Promise((resolve, reject) => {
        const child = spawnLedgerWorker(
          home,
          {
            LEDGER_FASTPATH_COUNT_FILE: countFile,
            LEDGER_FASTPATH_KEY: key,
            ...(degraded ? { LEDGER_FASTPATH_DEGRADED: '1' } : {}),
          },
          ['--require', hookFile],
        );
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fastpath probe exit ${code}`))));
        child.on('error', reject);
      });
    };

    // Phase 1 — a HEALTHY seq file: the fast path. Exactly ONE outcomes
    // read (the tier resolution's merged view); the pre-r15 floor scan
    // paid a second on every append.
    await probe();
    assert.equal(countReads(), 1, 'healthy file: one outcomes read — the floor is parsed, not scanned');
    assert.equal(Number(readFileSync(seqFile, 'utf8').trim()), 1, 'the seq advanced past the file value');

    // Phase 2 — a CORRUPTED (out-of-range) file: the parsed floor repairs
    // it with NO scan — still one read — and the file is rewritten valid.
    writeFileSync(seqFile, `${Number.MAX_SAFE_INTEGER - 1}\n`);
    await probe();
    assert.equal(countReads(), 1, 'corrupted file: the parsed floor repairs without a merged-view scan');
    assert.equal(
      Number(readFileSync(seqFile, 'utf8').trim()),
      2,
      'the corrupted file was rewritten from the parsed floor',
    );

    // Phase 3 — the repaired tree is fast again: the scan was a repair, not
    // a deferral to every subsequent append.
    await probe();
    assert.equal(countReads(), 1, 'after repair: still one read — the seq file is a real fast path');
    assert.equal(Number(readFileSync(seqFile, 'utf8').trim()), 3, 'the repaired file keeps advancing');

    // Phase 4 — the DEGRADED repair leg, in a FRESH process (the parent's
    // process-global lastAssignedSeq, bumped by earlier tests in this file,
    // would mask which source floored the counter): the r15 finding's "the
    // corruption-repair path still pays the scan once". Lock root blocked
    // and the seq file ABSENT, the degraded assignment floors from the
    // merged view alone — the probe reads the outcomes file exactly TWICE
    // (the tier resolution's read + the repair scan) and the spooled row
    // gets store-max+1, never a rewound duplicate.
    await probe(true);
    const [degradedReads, degradedSeq] = probeResult();
    assert.equal(degradedReads, 2, 'the degraded repair pays the merged-view scan exactly once (tier read + scan)');
    assert.equal(degradedSeq, 4, 'the degraded repair floors from the merged view (store max 3 + 1), never rewinds');
  }),
);

test(
  'saturation is a state, not a value: the ceiling never re-issues and the ceiling band is unreadable (round-16 finding 1)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const seqFile = join(paths.dir, 'approval-consents.seq');
    const CEILING = Number.MAX_SAFE_INTEGER - 2; // SEQ_CEILING: exclusive
    const SENTINEL = Number.MAX_SAFE_INTEGER;
    const key = 'h-r16-sat';
    const row = (evidence: ConsentEvidence, grantedAt: number, arrivalSeq: number | null, k = key): string =>
      stagedRowJson(evidence, grantedAt, arrivalSeq, k);
    const reset = (): void => wipeCounterScratch(paths);

    // Cell 1 — the r16 F1a shape: a seq FILE at the ceiling band (in no
    // row anywhere) is invalid, so the counter repairs from the parsed
    // floor: strictly increasing small seqs, no duplicate lane.
    reset();
    stageStore(home, '[]');
    writeFileSync(seqFile, `${CEILING}\n`);
    const seqs1: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { arrivalSeq } = recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: `h-r16-f${i}`,
        outcome: 'granted',
      });
      seqs1.push(arrivalSeq);
    }
    assert.ok(
      seqs1[0]! < seqs1[1]! && seqs1[1]! < seqs1[2]! && seqs1.every((s) => s < 1_000),
      `cell 1: the ceiling-band file was repaired — strictly increasing small seqs (got ${JSON.stringify(seqs1)})`,
    );

    // Cell 2 — the r16 F1b shape: a STORE row staged at the ceiling band
    // reads as the sentinel (unreadable) and never floors the counter.
    reset();
    stageStore(home, `[${row('posture', 100, CEILING, 'h-r16-band')}]`);
    const bandRow = readConsentEvents().find((e) => e.argsHash === 'h-r16-band');
    assert.equal(bandRow!.arrivalSeq, SENTINEL, 'cell 2: a ceiling-band row reads as the sentinel');
    const { arrivalSeq: bandSeq } = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
    });
    assert.ok(bandSeq < 1_000, `cell 2: the counter stayed on the small lane (got ${bandSeq})`);

    // Cell 3 — the r16 F1c C2S shape: a duplicate pair staged in the
    // ceiling band is unreadable on BOTH rows, so neither names an
    // original and the reuse records the caller's posture — no upgrade.
    reset();
    stageStore(home, `[${row('posture', 5000, CEILING, 'h-r16-c2s')},${row('terminal', 4000, CEILING, 'h-r16-c2s')}]`);
    const c2s = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-c2s',
      outcome: 'granted',
      evidence: 'posture',
    });
    const c2sRows = readConsentEvents().filter((e) => e.argsHash === 'h-r16-c2s' && e.grantedAt === c2s.grantedAt);
    assert.equal(c2sRows[0]!.evidence, 'posture', 'cell 3: the C2S pair records no upgrade at the top edge');

    // Cell 4 — GENUINE saturation: the store's last assignable seq is
    // CEILING-1; the next append takes the SENTINEL (never a re-issue of
    // CEILING-1, never a value in the band), the file stays at the last
    // assignable value, and the reuse still inherits the original's tier.
    reset();
    const lastAssignable = CEILING - 1;
    stageStore(home, `[${row('terminal', 100, lastAssignable, 'h-r16-top')}]`);
    const sat1 = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-top',
      outcome: 'granted',
      evidence: 'posture',
    });
    assert.equal(sat1.arrivalSeq, SENTINEL, 'cell 4: saturation marks the row chronology-unknown, never re-issues');
    assert.equal(
      Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10),
      lastAssignable,
      'cell 4: the file honestly stays at the last assignable value',
    );
    const sat2 = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-top',
      outcome: 'granted',
      evidence: 'posture',
    });
    assert.equal(sat2.arrivalSeq, SENTINEL, 'cell 4: saturation is sticky — no repair that re-issues');
    const topRows = readConsentEvents().filter((e) => e.argsHash === 'h-r16-top');
    assert.equal(
      topRows.filter((e) => e.evidence === 'terminal' && e.arrivalSeq === lastAssignable).length,
      1,
      'cell 4: the original row keeps its own seq',
    );
    assert.ok(
      topRows
        .filter((e) => e.grantedAt === sat1.grantedAt || e.grantedAt === sat2.grantedAt)
        .every((e) => e.evidence === 'terminal'),
      "cell 4: the reuses inherit the saturated original's tier (the sentinel rows are never the original)",
    );
  }),
);

test(
  'the floor consults every source the reader folds: taken sidecars floor the counter, and a blinded one marks unknown (round-16 finding 2)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const seqFile = join(paths.dir, 'approval-consents.seq');
    const key = 'h-r16-taken';
    const base = {
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      outcome: 'granted',
      scope: 'once',
    };
    const reset = (): void => wipeCounterScratch(paths);

    // Cell 1 — a READABLE .taken sidecar whose fold has not happened yet:
    // its committed row (seq 5) floors the next append (floor 5 -> seq 6),
    // never a re-issue of 5.
    reset();
    stageStore(
      home,
      JSON.stringify([
        { ...base, sessionId: 'ses-o', argsHash: 'h-r16-other', grantedAt: 900, evidence: 'posture', arrivalSeq: 4 },
      ]),
    );
    const readableTaken = join(paths.dir, 'approval-consents.json.spool.jsonl.taken-r16-1');
    writeFileSync(
      readableTaken,
      JSON.stringify({ ...base, argsHash: key, grantedAt: 5000, evidence: 'terminal', arrivalSeq: 5 }) + '\n',
    );
    const c1 = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: key,
      outcome: 'granted',
      evidence: 'posture',
    });
    assert.ok(
      c1.arrivalSeq > 5,
      `cell 1: the readable sidecar's seq floored the append above 5 (got ${c1.arrivalSeq})`,
    );
    const c1rows = readConsentEvents().filter((e) => e.arrivalSeq === 5);
    assert.equal(c1rows.length, 1, 'cell 1: seq 5 is owned by the sidecar row alone — no duplicate');

    // Cell 2 — a BLINDED .taken sidecar (the round-7 transient read
    // failure): its rows are committed and own seqs the floor cannot see,
    // so the append marks the row chronology-UNKNOWN rather than risk a
    // duplicate; after the read recovers the counter continues from the
    // sidecar's real seq.
    reset();
    stageStore(
      home,
      JSON.stringify([
        { ...base, sessionId: 'ses-o', argsHash: 'h-r16-other', grantedAt: 900, evidence: 'posture', arrivalSeq: 4 },
      ]),
    );
    const blindedTaken = join(paths.dir, 'approval-consents.json.spool.jsonl.taken-r16-2');
    writeFileSync(
      blindedTaken,
      JSON.stringify({ ...base, argsHash: 'h-r16-blind', grantedAt: 5000, evidence: 'terminal', arrivalSeq: 5 }) + '\n',
    );
    chmodSync(blindedTaken, 0o000);
    const c2 = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-blind',
      outcome: 'granted',
      evidence: 'posture',
    });
    assert.equal(
      c2.arrivalSeq,
      Number.MAX_SAFE_INTEGER,
      'cell 2: a blinded sidecar marks the row unknown — never a duplicate of the seqs it hides',
    );
    chmodSync(blindedTaken, 0o600);
    const c3 = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-blind',
      outcome: 'granted',
      evidence: 'posture',
    });
    assert.ok(
      c3.arrivalSeq > 5 && c3.arrivalSeq < 1_000,
      `cell 3: after recovery the counter continues past the sidecar's seq (got ${c3.arrivalSeq})`,
    );
  }),
);

test(
  'the degraded path never trusts a valid-but-rewound seq file: the merged view floors it (round-16 finding 3)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const seqFile = join(paths.dir, 'approval-consents.seq');
    // A store whose rows own seqs 0..3, the seq file rewound to a VALID 1
    // (the r14 threat: a stale restore / partial write), the lock root
    // blocked — the append degrades. Pre-r16 the valid file short-circuited
    // the repair and the spooled row duplicated seq 2.
    const rows = [0, 1, 2, 3].map((i) =>
      JSON.stringify({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: `h-r16-rw-${i}`,
        outcome: 'granted',
        grantedAt: 1000 + i,
        scope: 'once',
        evidence: 'posture',
        arrivalSeq: i,
      }),
    );
    stageStore(home, `[${rows.join(',')}]`);
    writeFileSync(seqFile, '1\n');
    rmSync(paths.lockRoot, { recursive: true, force: true });
    writeFileSync(paths.lockRoot, 'not-a-directory');
    const degraded = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r16-rw-new',
      outcome: 'granted',
      evidence: 'posture',
    });
    rmSync(paths.lockRoot, { force: true });
    assert.ok(
      degraded.arrivalSeq > 3,
      `the degraded append floors from the merged view, not the rewound file (got ${degraded.arrivalSeq})`,
    );
    const dupes = readConsentEvents().filter((e) => e.arrivalSeq === degraded.arrivalSeq);
    assert.equal(dupes.length, 1, "no row owned the new arrival's seq — the r14 guarantee holds on the degraded path");
    assert.equal(
      Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10),
      degraded.arrivalSeq,
      'the file was restored monotonically',
    );
  }),
);

test(
  'the annotate guard counts the full identity, skips unreadable rows, and binds the seq-less legacy shape (round-16 findings 5 and 6)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const T = 1_700_000_000_000;
    const SENTINEL = Number.MAX_SAFE_INTEGER;
    const CEILING = Number.MAX_SAFE_INTEGER - 2;
    const annotate = (
      argsHash: string,
      arrivalSeq: number | undefined,
      detail: 'failed' | 'delivered' = 'failed',
    ): void => {
      annotateDispatchOutcome({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash,
        arrivalStamp: T,
        arrivalSeq,
        outcomeDetail: detail,
      });
    };
    const wipeOutcomeLines = (): void => {
      rmSync(join(paths.dir, 'approval-consents.json.outcomes.jsonl'), { force: true });
      rmSync(paths.spool, { force: true });
    };

    // B3 — a full (key, stamp, seq) identity collision: two rows, one
    // identity. The guard counts and skips — no row receives the line.
    wipeOutcomeLines();
    stageStore(
      home,
      JSON.stringify([
        baseEvent({ sessionId: 'ses', argsHash: 'h-r16-b3', grantedAt: T, arrivalSeq: 20 }),
        baseEvent({ sessionId: 'ses', argsHash: 'h-r16-b3', grantedAt: T, arrivalSeq: 20 }),
      ]),
    );
    annotate('h-r16-b3', 20);
    let rows = readConsentEvents().filter((e) => e.argsHash === 'h-r16-b3');
    assert.equal(rows[0]!.outcomeDetail, undefined, 'B3: an indistinguishable identity pair binds nothing (row 0)');
    assert.equal(rows[1]!.outcomeDetail, undefined, 'B3: an indistinguishable identity pair binds nothing (row 1)');

    // B4 — a UNIQUE key+stamp match on a row with NO seq field binds: the
    // line carries no arrivalSeq (legacy-keyed) and the legacy fold
    // applies it — the r15 conjunct had left this shape unbindable and the
    // legacy fold unreachable by any writer.
    wipeOutcomeLines();
    const { arrivalSeq: legacySeq, ...legacyRow } = baseEvent({ sessionId: 'ses', argsHash: 'h-r16-b4', grantedAt: T });
    void legacySeq;
    stageStore(home, JSON.stringify([legacyRow]));
    annotate('h-r16-b4', undefined);
    rows = readConsentEvents().filter((e) => e.argsHash === 'h-r16-b4');
    assert.equal(rows[0]!.outcomeDetail, 'failed', 'B4: a unique seq-less legacy row binds through the fallback');

    // Cell 4 — an unreadable row never matches: a sentinel-valued row at
    // key+stamp does not bind a threaded sentinel identity (the dropped/
    // saturated shape), and a ceiling-band row does not bind a threaded
    // ceiling value — the guard range-normalizes both sides.
    wipeOutcomeLines();
    stageStore(
      home,
      JSON.stringify([
        baseEvent({ sessionId: 'ses', argsHash: 'h-r16-c4a', grantedAt: T, arrivalSeq: SENTINEL }),
        baseEvent({ sessionId: 'ses', argsHash: 'h-r16-c4b', grantedAt: T, arrivalSeq: CEILING }),
      ]),
    );
    annotate('h-r16-c4a', SENTINEL);
    annotate('h-r16-c4b', CEILING);
    rows = readConsentEvents();
    assert.equal(
      rows.find((e) => e.argsHash === 'h-r16-c4a')!.outcomeDetail,
      undefined,
      'cell 4a: a sentinel identity binds nothing — ownership is unprovable at unknown chronology',
    );
    assert.equal(
      rows.find((e) => e.argsHash === 'h-r16-c4b')!.outcomeDetail,
      undefined,
      'cell 4b: a ceiling-band row never matches a threaded band value',
    );
  }),
);

test(
  'the seq file is an optimization, never a decision-maker: every band value repairs from the parsed floor (round-17 finding 1)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const seqFile = join(paths.dir, 'approval-consents.seq');
    const LAST_VALID = Number.MAX_SAFE_INTEGER - 3; // the last value below the exclusive ceiling
    const fresh = (): void => {
      wipeCounterScratch(paths);
      stageStore(home, '[]');
    };
    const ask = (key: string, evidence?: ConsentEvidence) =>
      recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: key,
        outcome: 'granted',
        ...(evidence !== undefined ? { evidence } : {}),
      });

    // Cell 1 — the r16 sticky trigger: a corrupted-but-in-range file at
    // the LAST VALID value used to saturate every append forever with no
    // repair (the r15 stall one value inward). Post-fix the file floors
    // nothing: real seqs, and the file is REWRITTEN to the parsed truth.
    fresh();
    writeFileSync(seqFile, `${LAST_VALID}\n`);
    const ids = [ask('h-r17-band-0'), ask('h-r17-band-1'), ask('h-r17-band-2')].map((a) => a.arrivalSeq);
    assert.ok(
      ids[0]! < ids[1]! && ids[1]! < ids[2]! && ids.every((s) => s < 1_000),
      `cell 1: the last-valid file value floors nothing — strictly increasing small seqs (got ${JSON.stringify(ids)})`,
    );
    assert.equal(
      Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10),
      ids[2],
      'cell 1: the file was rewritten to the parsed truth',
    );

    // Cell 2 — the tier inheritance the sticky state disabled: a terminal
    // original beside the corrupted file, then a posture reuse — the
    // reuse inherits terminal (the never-upgrade rule), not posture.
    fresh();
    writeFileSync(seqFile, `${LAST_VALID}\n`);
    ask('h-r17-inherit', 'terminal');
    const inherit = ask('h-r17-inherit', 'posture');
    const inheritRows = readConsentEvents().filter((e) => e.argsHash === 'h-r17-inherit');
    const inheritRow = inheritRows.find((e) => e.grantedAt === inherit.grantedAt);
    assert.equal(
      inheritRow!.evidence,
      'terminal',
      'cell 2: the reuse inherits the terminal original — no mis-grade DOWN',
    );

    // Cell 3 — pruning releases the counter: with the corrupted file
    // gone from every floor, a store pruned below the ceiling resumes
    // assignable seqs (the r16 sticky rule's operator recovery — deleting
    // the file — is no longer needed).
    fresh();
    stageStore(
      home,
      JSON.stringify([
        baseEvent({ sessionId: 'ses', argsHash: 'h-r17-prune', grantedAt: 100, arrivalSeq: LAST_VALID }),
      ]),
    );
    const satFirst = ask('h-r17-prune-new');
    assert.equal(
      satFirst.arrivalSeq,
      Number.MAX_SAFE_INTEGER,
      'cell 3: a genuine parsed-max saturation still marks unknown',
    );
    // the operator prunes the store below the ceiling:
    stageStore(
      home,
      JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-prune', grantedAt: 100, arrivalSeq: 3 })]),
    );
    const resumed = ask('h-r17-prune-after');
    assert.ok(
      resumed.arrivalSeq > 3 && resumed.arrivalSeq < 1_000,
      `cell 3: pruning the store releases the counter (got ${resumed.arrivalSeq})`,
    );
    assert.equal(
      Number.parseInt(readFileSync(seqFile, 'utf8').trim(), 10),
      resumed.arrivalSeq,
      'cell 3: the file reflects the resumed counter',
    );
  }),
);

test(
  'the degraded floor consults the spool stream: committed spool rows floor the append, a blinded spool marks unknown (round-17 finding 2)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const spoolRows = (rows: Array<{ argsHash: string; arrivalSeq: number }>): void => {
      writeFileSync(
        paths.spool,
        rows
          .map((r) =>
            JSON.stringify(
              baseEvent({ sessionId: 'ses', argsHash: r.argsHash, grantedAt: 5_000, arrivalSeq: r.arrivalSeq }),
            ),
          )
          .join('\n') + '\n',
      );
    };
    const degrade = (): void => {
      rmSync(paths.lockRoot, { recursive: true, force: true });
      writeFileSync(paths.lockRoot, 'not-a-directory');
    };

    // Cell 1 — the r17 shape: the spool owns committed rows at seq 6 and
    // 7 (the merged view's whole-file read fails for the giant class; a
    // small spool here exercises the same floor source). The degraded
    // append must take a seq ABOVE the spool's max — never a re-issue.
    wipeCounterScratch(paths);
    stageStore(
      home,
      JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-s-other', grantedAt: 900, arrivalSeq: 5 })]),
    );
    spoolRows([
      { argsHash: 'h-r17-sp-K', arrivalSeq: 6 },
      { argsHash: 'h-r17-sp-K', arrivalSeq: 7 },
    ]);
    degrade();
    const d = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r17-sp-K',
      outcome: 'granted',
      evidence: 'posture',
    });
    rmSync(paths.lockRoot, { force: true });
    assert.ok(
      d.arrivalSeq > 7,
      `cell 1: the spool's committed seqs floor the degraded append above 7 (got ${d.arrivalSeq})`,
    );
    const owners = readConsentEvents().filter((e) => e.arrivalSeq === 6 || e.arrivalSeq === 7);
    assert.equal(owners.length, 2, 'cell 1: seqs 6 and 7 each have exactly one owner — no duplicate re-issued');

    // Cell 1b — the giant-spool shape: a spool the merged view CANNOT read
    // whole (over the tightened test limit — the r7 ERR_STRING_TOO_LONG
    // class) still floors the degraded append through the stream: the
    // merged view sees no lines, the stream sees the seqs, the append
    // takes a seq above them — never a re-issue.
    const prevLimit = process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT;
    process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT = '64';
    try {
      wipeCounterScratch(paths);
      stageStore(
        home,
        JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-g-other', grantedAt: 900, arrivalSeq: 5 })]),
      );
      writeFileSync(
        paths.spool,
        JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: 'h-r17-g-K', grantedAt: 5_000, arrivalSeq: 6 })) +
          '\n' +
          'x'.repeat(200) +
          '\n',
      );
      degrade();
      const g = recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: 'h-r17-g-K',
        outcome: 'granted',
        evidence: 'posture',
      });
      rmSync(paths.lockRoot, { force: true });
      assert.ok(
        g.arrivalSeq > 6,
        `cell 1b: the unreadable-whole spool's committed seq floors the append above 6 through the stream (got ${g.arrivalSeq})`,
      );
    } finally {
      if (prevLimit === undefined) delete process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT;
      else process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT = prevLimit;
    }

    // Cell 2 — a BLINDED spool (the unreadable class): the degraded
    // append marks the row chronology-unknown rather than risk a
    // duplicate of the unknowable seqs behind it.
    wipeCounterScratch(paths);
    stageStore(
      home,
      JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-b-other', grantedAt: 900, arrivalSeq: 4 })]),
    );
    spoolRows([{ argsHash: 'h-r17-bl-K', arrivalSeq: 5 }]);
    chmodSync(paths.spool, 0o000);
    degrade();
    const blinded = recordAskModeConsent({
      sessionId: 'ses',
      tool: 'huaweicloud_run_approved_command',
      argsHash: 'h-r17-bl-K',
      outcome: 'granted',
      evidence: 'posture',
    });
    rmSync(paths.lockRoot, { force: true });
    chmodSync(paths.spool, 0o600);
    assert.equal(
      blinded.arrivalSeq,
      Number.MAX_SAFE_INTEGER,
      'cell 2: a blinded spool marks the arrival chronology-unknown — never a duplicate',
    );
  }),
);

test(
  'an over-limit whole read is skipped before the bytes, its seq fields still floor, and repeated appends stay correct (round-17 finding 3)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const prevLimit = process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT;
    process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT = '64'; // the safe-directional test seam
    try {
      // A sidecar OVER the (tightened) whole-read limit: the merged view
      // reads no lines from it (the skip happens before the bytes), but
      // the streaming scan extracts its seqs — the append floors from it,
      // no duplicate, and the SECOND append continues past the first (the
      // memo is correct, not just cheap).
      wipeCounterScratch(paths);
      stageStore(
        home,
        JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-ov-other', grantedAt: 900, arrivalSeq: 4 })]),
      );
      const over = join(paths.dir, 'approval-consents.json.spool.jsonl.taken-r17-over');
      const big = 'x'.repeat(200);
      writeFileSync(
        over,
        [
          JSON.stringify(baseEvent({ sessionId: 'ses', argsHash: 'h-r17-ov-K', grantedAt: 5_000, arrivalSeq: 5 })),
          big,
          big,
          big,
        ].join('\n') + '\n',
      );
      const visible = readConsentEvents().filter((e) => e.argsHash === 'h-r17-ov-K');
      assert.equal(
        visible.length,
        0,
        'the over-limit sidecar reads as no lines in the merged view — skipped before the bytes',
      );
      const a1 = recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: 'h-r17-ov-new1',
        outcome: 'granted',
      });
      assert.ok(
        a1.arrivalSeq > 5,
        `the streamed seq fields floor the append above the sidecar's max (got ${a1.arrivalSeq})`,
      );
      const a2 = recordAskModeConsent({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash: 'h-r17-ov-new2',
        outcome: 'granted',
      });
      assert.ok(
        a2.arrivalSeq > a1.arrivalSeq,
        'the second append continues past the first — the memo keeps the floor correct',
      );
      // The sidecar row is invisible to the view (the first cell), so the
      // no-re-issue property is observed at the source: the sidecar keeps
      // its bytes verbatim (kept, not folded, not removed) and its row
      // still owns seq 5 — the counter floored above it twice and never
      // re-issued it.
      const sidecarBytes = readFileSync(over, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      assert.equal(sidecarBytes.length, 4, 'the over-limit sidecar is kept verbatim — not folded, not removed');
      assert.equal(
        (JSON.parse(sidecarBytes[0]!) as { arrivalSeq?: number }).arrivalSeq,
        5,
        'the sidecar row keeps its seq — floored above, never re-issued',
      );
    } finally {
      if (prevLimit === undefined) delete process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT;
      else process.env.HUAWEICLOUD_LEDGER_WHOLE_READ_LIMIT = prevLimit;
    }
  }),
);

test(
  'the outcome-line reader mirrors the writer: out-of-space line seqs and full-identity twins bind nothing (round-17 finding 4)',
  withLedgerHome(async (home) => {
    const paths = ledgerSpoolPaths(home);
    const T = 1_700_000_000_000;
    const SENTINEL = Number.MAX_SAFE_INTEGER;
    const outcomes = join(paths.dir, 'approval-consents.json.outcomes.jsonl');
    const stageOutcomeLines = (lines: string[]): void => {
      rmSync(outcomes, { force: true });
      writeFileSync(outcomes, lines.join('\n') + '\n');
    };
    const line = (argsHash: string, arrivalSeq: number | null, detail: string): string =>
      JSON.stringify({
        sessionId: 'ses',
        tool: 'huaweicloud_run_approved_command',
        argsHash,
        grantedAt: T,
        ...(arrivalSeq !== null ? { arrivalSeq } : {}),
        outcomeDetail: detail,
      });

    // Cell 1 — a sentinel-valued row plus a sentinel-seq line naming it:
    // neither side is a provable identity; the reader (like the r16
    // writer's guard) binds nothing.
    wipeCounterScratch(paths);
    stageOutcomeLines([line('h-r17-e1', SENTINEL, 'failed')]);
    stageStore(
      home,
      JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-e1', grantedAt: T, arrivalSeq: SENTINEL })]),
    );
    let rows = readConsentEvents().filter((e) => e.argsHash === 'h-r17-e1');
    assert.equal(rows[0]!.outcomeDetail, undefined, 'cell 1: a sentinel-seq line binds a sentinel row never');

    // Cell 2 — a full-identity twin in the store and a seq-bearing line
    // naming the shared identity: the reader counts and skips, never
    // binds array-last.
    wipeCounterScratch(paths);
    stageOutcomeLines([line('h-r17-e2', 20, 'delivered')]);
    stageStore(
      home,
      JSON.stringify([
        baseEvent({ sessionId: 'ses', argsHash: 'h-r17-e2', grantedAt: T, arrivalSeq: 20 }),
        baseEvent({ sessionId: 'ses', argsHash: 'h-r17-e2', grantedAt: T, arrivalSeq: 20 }),
      ]),
    );
    rows = readConsentEvents().filter((e) => e.argsHash === 'h-r17-e2');
    assert.equal(rows[0]!.outcomeDetail, undefined, 'cell 2: the identity twin binds nothing (row 0)');
    assert.equal(rows[1]!.outcomeDetail, undefined, 'cell 2: the identity twin binds nothing (row 1)');

    // Cell 3 — the r15-era writer's other shape: a line with a seq in the
    // ceiling band (invalid) is dropped entirely — never legacy-keyed.
    wipeCounterScratch(paths);
    stageOutcomeLines([line('h-r17-e3', Number.MAX_SAFE_INTEGER - 2, 'failed')]);
    stageStore(
      home,
      JSON.stringify([baseEvent({ sessionId: 'ses', argsHash: 'h-r17-e3', grantedAt: T, arrivalSeq: 20 })]),
    );
    rows = readConsentEvents().filter((e) => e.argsHash === 'h-r17-e3');
    assert.equal(
      rows[0]!.outcomeDetail,
      undefined,
      'cell 3: a ceiling-band line seq binds nothing and is never legacy-keyed',
    );

    // Cell 4 — the legacy line (no arrivalSeq — the r16 seq-less-row
    // writer's product) still binds its unique row: the reader's hardening
    // must not narrow the legacy contract.
    wipeCounterScratch(paths);
    stageOutcomeLines([line('h-r17-e4', null, 'failed')]);
    const { arrivalSeq: legacySeq, ...legacyRow } = baseEvent({ sessionId: 'ses', argsHash: 'h-r17-e4', grantedAt: T });
    void legacySeq;
    stageStore(home, JSON.stringify([legacyRow]));
    rows = readConsentEvents().filter((e) => e.argsHash === 'h-r17-e4');
    assert.equal(rows[0]!.outcomeDetail, 'failed', 'cell 4: the legacy seq-less line still binds its unique row');
  }),
);

test(
  'a ledger-internal failure never fails the approved call: a relative state dir degrades to a no-op (round-4 finding 4)',
  withLedgerHome(async () => {
    // devkitStateBase() THROWS on a relative HUAWEICLOUD_STATE_DIR — inside
    // the lock, on the data path. The ledger's contract (and trunk's
    // behavior: trunk recorded no consent at all) is that an internal
    // failure degrades to a no-op, never a raw error to the call the user
    // just approved. Both entry points must simply return.
    const previous = process.env.HUAWEICLOUD_STATE_DIR;
    process.env.HUAWEICLOUD_STATE_DIR = 'relative-state';
    try {
      recordAskModeConsent({ sessionId: 'ses-x', tool: 't', argsHash: 'h', outcome: 'granted' });
      appendConsentEvent(baseEvent({ sessionId: 'ses-y' }));
    } finally {
      if (previous === undefined) delete process.env.HUAWEICLOUD_STATE_DIR;
      else process.env.HUAWEICLOUD_STATE_DIR = previous;
    }
    // Reaching here is the assertion: neither call threw. The store the
    // valid HUAWEICLOUD_HOME would host is untouched by the no-op (the
    // throwing state dir shadows it).
    assert.deepEqual(readConsentEvents(), [], 'the degraded append recorded nothing — trunk parity');
  }),
);

test(
  'concurrent appends serialize: every committed event survives (round-2 finding 3)',
  withLedgerHome(async () => {
    // The append is a cross-process read-modify-write; before the per-store
    // lock, concurrent writers both appended to the same snapshot and each
    // erased the other's committed events. Workers re-exec this test file
    // (the hook-parity spawn pattern) and append through the REAL
    // appendConsentEvent; the store must hold every event.
    const WORKERS = 3;
    const PER_WORKER = 10;
    for (let worker = 0; worker < WORKERS; worker += 1) {
      const run = spawnSync(process.execPath, ['--experimental-strip-types', 'test/approval-ledger.test.ts'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          LEDGER_WORKER: String(worker),
          LEDGER_PER_WORKER: String(PER_WORKER),
          HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
          // The suite's own runner context must not leak into the worker:
          // NODE_TEST_CONTEXT makes `node --test` skip the file as a
          // recursive run, silently appending nothing. The worker runs the
          // file as a plain module — its worker block exits before any test
          // registers.
          NODE_TEST_CONTEXT: undefined,
          NODE_TEST_WORKER_ID: undefined,
        },
      });
      assert.equal(run.status, 0, `worker ${worker} failed: ${(run.stderr || '').slice(0, 400)}`);
    }
    const expected: Array<string> = [];
    for (let worker = 0; worker < WORKERS; worker += 1) {
      for (let i = 0; i < PER_WORKER; i += 1) expected.push(`worker-${worker}-${i}`);
    }
    const stored = readConsentEvents().map((event) => event.sessionId);
    assert.deepEqual(
      [...stored].sort((a, b) => a.localeCompare(b)),
      [...expected].sort((a, b) => a.localeCompare(b)),
      'every append from every worker survived the concurrent run',
    );
  }),
);

test(
  'same-millisecond quarantines never overwrite each other (round-2 finding 4)',
  withLedgerHome(async (home) => {
    // The sidecar name carries pid + a process-lifetime counter, so two
    // quarantines in the same millisecond keep distinct files and the
    // FIRST one always preserves the original bytes it quarantined.
    const dir = join(home, '.config', 'huaweicloud');
    const originals = ['{"first":"corrupt"}', '{"second":"corrupt"}'];
    const quarantined: string[] = [];
    for (const original of originals) {
      const sidecar = quarantineOnce(home, original, quarantined);
      quarantined.push(sidecar);
      assert.equal(readFileSync(join(dir, sidecar), 'utf8'), original, 'each quarantine keeps its own bytes');
    }
    assert.equal(quarantined.length, new Set(quarantined).size, 'the two quarantines produced distinct sidecars');
  }),
);

test(
  'when even the quarantine fails, the append refuses to write',
  withLedgerHome(async (home) => {
    // The carve-out: if the unreadable store cannot be moved aside (a
    // read-only parent), the append is dropped entirely — evidence is
    // preserved at the cost of the append, never the other way around.
    const dir = join(home, '.config', 'huaweicloud');
    const file = stageStore(home, '{"not":"an array"}');
    const original = readFileSync(file, 'utf8');
    chmodSync(dir, 0o555); // r-x: rename into the dir fails
    try {
      appendConsentEvent(baseEvent({ sessionId: 'ses-new' }));
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(readFileSync(file, 'utf8'), original, 'the append refused to overwrite the store it could not read');
    assert.deepEqual(readConsentEvents(), [], 'nothing was recorded');
  }),
);

test(
  'a malformed store reads as absent entries, never as values',
  withLedgerHome(async (home) => {
    stageStore(
      home,
      JSON.stringify([
        'a bare string',
        null,
        { tool: 'x' },
        { ...baseEvent(), evidence: 'hand-edited-tier' },
        { ...baseEvent(), outcome: 'maybe' },
        { ...baseEvent(), grantedAt: 'not-a-number' },
        baseEvent(),
      ]),
    );
    const events = readConsentEvents();
    assert.equal(events.length, 1, 'every malformed entry reads as absent, the well-formed one survives');
    assert.equal(events[0]!.evidence, 'posture');
  }),
);
