import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  'recordAskModeConsent writes the posture tier by default and honors an inherited tier',
  withLedgerHome(async () => {
    recordAskModeConsent({
      sessionId: 'ses-a',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
    });
    recordAskModeConsent({
      sessionId: 'ses-a',
      tool: 'huaweicloud_run_approved_command',
      argsHash: ARGS_HASH,
      outcome: 'granted',
      evidence: 'terminal',
    });

    const events = readConsentEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.evidence, 'posture', 'an ask-mode arrival records the posture tier');
    assert.equal(events[1]!.evidence, 'terminal', 'a memo-reuse event inherits the original tier verbatim');
    assert.ok(events[0]!.grantedAt > 0);
    assert.equal(events[0]!.scope, 'once');
  }),
);

test(
  'a memo reuse never upgrades the original evidence tier',
  withLedgerHome(async () => {
    // The PR-1 ledger rule: a posture-grade yes can never be re-recorded as
    // terminal-grade on retry — the reuse event carries the ORIGINAL tier.
    appendConsentEvent(baseEvent({ evidence: 'posture' }));
    const original = readConsentEvents()[0]!;
    recordAskModeConsent({
      sessionId: original.sessionId,
      tool: original.tool,
      argsHash: original.argsHash,
      outcome: 'granted',
      evidence: original.evidence,
    });
    const events = readConsentEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1]!.evidence, 'posture', 'the reuse inherited the posture tier, not a fresh terminal one');
  }),
);

test(
  'a malformed store reads as absent entries, never as values',
  withLedgerHome(async (home) => {
    const file = join(home, '.config', 'huaweicloud', 'approval-consents.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(
      file,
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
