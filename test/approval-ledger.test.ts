import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendConsentEvent,
  readConsentEvents,
  recordAskModeConsent,
} from '../plugins/huaweicloud-core/src/approval-ledger.ts';
import { hashArgs } from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import type { ConsentEvent } from '../plugins/huaweicloud-core/src/approval-types.ts';
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
