import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { contendOneAppend, spawnLedgerWorker, waitForLedgerClaim } from './approval-ledger-harness.ts';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendConsentEvent,
  readConsentEvents,
  recordAskModeConsent,
} from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { hashArgs } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import type { ConsentEvent, ConsentEvidence } from '../plugins/huaweicloud-core/src/approval-types.ts';
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
  ...overrides,
});

// Worker mode for the concurrency test: append N tagged events through the
// real appendConsentEvent into the parent's HUAWEICLOUD_HOME, then exit
// before any test registers — a worker runs ONLY its appends (no nested
// worker spawning, no suite re-run).
if (process.env.LEDGER_WORKER) {
  const worker = process.env.LEDGER_WORKER!;
  const perWorker = Number(process.env.LEDGER_PER_WORKER || 10);
  for (let i = 0; i < perWorker; i += 1) {
    appendConsentEvent(baseEvent({ sessionId: `worker-${worker}-${i}`, argsHash: `h-${worker}-${i}` }));
  }
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
    assert.deepEqual(events[0], baseEvent());
    assert.deepEqual(
      events[1],
      baseEvent({ outcome: 'denied', evidence: 'terminal', scope: 'session', sessionId: 'ses-2' }),
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
