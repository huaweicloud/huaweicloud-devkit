import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCase, type Recordings } from './e2e/evaluate.ts';
import type { E2eCase, Expectation } from './e2e/types.ts';

// The evaluator is a pure function over recordings — these tests pin its
// contract (sequence semantics, matcher strictness, liveness) with zero
// filesystem and zero LLM, the same pattern as e2e-env-policy.test.ts.

function recordings(partial: Partial<Recordings>): Recordings {
  return {
    hcloud: [],
    toolCalls: [],
    disclosures: [],
    http: [],
    gateway: [],
    ws: [],
    files: {},
    finalText: null,
    exitCode: 0,
    ...partial,
  };
}

function caseWith(expect: Expectation[], recordings: Recordings) {
  const caseDef: E2eCase = {
    id: 'pin',
    pack: 'core',
    prompt: '',
    fixtures: {},
    expect,
    budget: { timeoutMs: 1, attempts: 1 },
  };
  return evaluateCase(caseDef, recordings);
}

test('sequence passes when the steps appear in order', () => {
  const verdict = caseWith(
    [
      {
        kind: 'sequence',
        channel: 'toolCall',
        steps: ['huaweicloud_plan_cli_command', 'huaweicloud_run_approved_command'],
      },
    ],
    recordings({
      toolCalls: [
        { name: 'huaweicloud_check_cli', args: {}, ok: true },
        { name: 'huaweicloud_plan_cli_command', args: {}, ok: true },
        { name: 'huaweicloud_run_approved_command', args: {}, ok: true },
      ],
    }),
  );
  assert.equal(verdict.expectations[0]!.pass, true);
  assert.equal(verdict.liveness, true);
});

test('sequence fails when the steps are reordered — the approval regression it exists to catch', () => {
  const verdict = caseWith(
    [
      {
        kind: 'sequence',
        channel: 'toolCall',
        steps: ['huaweicloud_plan_cli_command', 'huaweicloud_run_approved_command'],
      },
    ],
    recordings({
      toolCalls: [
        { name: 'huaweicloud_run_approved_command', args: {}, ok: true },
        { name: 'huaweicloud_plan_cli_command', args: {}, ok: true },
      ],
    }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
  assert.match(verdict.expectations[0]!.evidence, /stopped at step 2/);
});

test('sequence tolerates extra records between steps', () => {
  const verdict = caseWith(
    [{ kind: 'sequence', channel: 'gateway', steps: ['get_api', 'execute_api'] }],
    recordings({
      gateway: [
        { method: 'tools/list', tool: null, args: {} },
        { method: 'tools/call', tool: 'get_api', args: {} },
        { method: 'tools/call', tool: 'list_products', args: {} },
        { method: 'tools/call', tool: 'execute_api', args: {} },
      ],
    }),
  );
  assert.equal(verdict.expectations[0]!.pass, true);
});

test('sequence over http matches method+path steps in order', () => {
  const steps = [
    { method: 'GET', path: '/v3/projects' },
    { method: 'POST', path: '/credentials' },
  ];
  const ok = caseWith(
    [{ kind: 'sequence', channel: 'http', steps }],
    recordings({
      http: [
        { method: 'GET', path: '/user/generatorUserIDHash' },
        { method: 'GET', path: '/v3/projects' },
        { method: 'POST', path: '/credentials' },
      ],
    }),
  );
  assert.equal(ok.expectations[0]!.pass, true);

  const reordered = caseWith(
    [{ kind: 'sequence', channel: 'http', steps }],
    recordings({
      http: [
        { method: 'POST', path: '/credentials' },
        { method: 'GET', path: '/v3/projects' },
      ],
    }),
  );
  assert.equal(reordered.expectations[0]!.pass, false);
});

test('sequence fails on an empty channel with the trace in the evidence', () => {
  const verdict = caseWith([{ kind: 'sequence', channel: 'gateway', steps: ['execute_api'] }], recordings({}));
  assert.equal(verdict.expectations[0]!.pass, false);
  assert.match(verdict.expectations[0]!.evidence, /\(empty\)/);
});

test('hcloud argv matching is order-insensitive on flags — pinned contract', () => {
  const exp: Expectation = {
    kind: 'hcloud',
    head: ['VPC', 'CreateSecurityGroup'],
    flags: { name: 'sg-1', 'cli-region': 'cn-north-4' },
    times: { min: 1, max: 1 },
  };
  const reordered = caseWith(
    [exp],
    recordings({ hcloud: [{ argv: ['VPC', 'CreateSecurityGroup', '--cli-region=cn-north-4', '--name=sg-1'] }] }),
  );
  assert.equal(reordered.expectations[0]!.pass, true);
});

test('a vacuous pass is impossible: no boundary activity fails the case even when every expectation passes', () => {
  const verdict = caseWith([{ kind: 'hcloud', head: ['VPC', 'X'], times: { min: 0, max: 0 } }], recordings({}));
  assert.equal(verdict.liveness, false);
  assert.equal(verdict.pass, false);
});

test('disclosure liveness: never-booted fails, half-dead fails on the model turn, asking passes, overreach fails on assertions', () => {
  // The vendor-ambiguity guard's evidence mode: an initialize-handshake
  // disclosure (toolsList/instructions — written at the transport wire
  // face BEFORE any model turn) conjoined with a zero agent exit code
  // (the honest cross-leg model-turn proof; codex's -o finalText can
  // exist for a turn that never completed, so exitCode carries the
  // proof instead). The conjunction closes the half-dead chain: server
  // boots and handshakes, then the model wire dies — disclosures alone
  // would vacuously pass the zero-activity expectations and reset the
  // runner's dead-agent streak.
  const expect: Expectation[] = [{ kind: 'hcloud', head: [], times: { min: 0, max: 0 } }];
  const guardedCase: E2eCase = {
    id: 'vendor-guard',
    pack: 'core',
    prompt: '',
    fixtures: {},
    expect,
    liveness: 'disclosure',
    budget: { timeoutMs: 1, attempts: 1 },
  };
  // Never-booted chain: no initialize, no toolsList — fails on disclosures
  // even though the zero-hcloud expectation passes vacuously.
  const dead = evaluateCase(guardedCase, recordings({ exitCode: 1 }));
  assert.equal(dead.liveness, false);
  assert.equal(dead.pass, false);
  // Half-dead chain: handshake completed (disclosures recorded before the
  // model turn), then the agent exited non-zero — disclosures alone would
  // pass; the exit-code conjunct catches it.
  const halfDead = evaluateCase(
    guardedCase,
    recordings({
      disclosures: [{ event: 'toolsList', toolCount: 52 }, { event: 'instructions' }],
      exitCode: 1,
    }),
  );
  assert.equal(halfDead.liveness, false);
  assert.equal(halfDead.pass, false);
  // Timeout-kill signal death: exitCode null with disclosures — same
  // failure as a non-zero exit (null is not a completed model turn).
  const killed = evaluateCase(
    guardedCase,
    recordings({
      disclosures: [{ event: 'toolsList', toolCount: 52 }],
      exitCode: null,
    }),
  );
  assert.equal(killed.liveness, false);
  // toolsListChanged is NOT a handshake event: a change-notification-only
  // recording is not initialize proof (it fires from packs_configure in an
  // already-initialized session — unreachable without prior handshake
  // events in a real trace, and the filter keeps the mode's documented
  // contract frozen).
  const changedOnly = evaluateCase(
    guardedCase,
    recordings({
      disclosures: [{ event: 'toolsListChanged', toolCount: 51 }],
      exitCode: 0,
    }),
  );
  assert.equal(changedOnly.liveness, false);
  // Live chain, model correctly asks instead of calling: zero boundary
  // activity, handshake disclosures present, clean exit — passes.
  const asking = evaluateCase(
    guardedCase,
    recordings({
      disclosures: [{ event: 'toolsList', toolCount: 52 }, { event: 'instructions' }],
      exitCode: 0,
    }),
  );
  assert.equal(asking.liveness, true);
  assert.equal(asking.pass, true);
  // Live chain, model overreaches: disclosures prove the chain, the
  // zero-hcloud assertion carries the failure (red for the right
  // reason, never the vacuous-green of a dead or half-dead harness).
  const overreach = evaluateCase(
    guardedCase,
    recordings({
      disclosures: [{ event: 'toolsList', toolCount: 52 }],
      hcloud: [{ argv: ['ECS', 'ListServersDetails'] }],
      exitCode: 0,
    }),
  );
  assert.equal(overreach.liveness, true);
  assert.equal(overreach.pass, false);
  assert.equal(overreach.expectations[0]!.pass, false);
});

test('noToolCall fails with the offending args as evidence when the forbidden call happened', () => {
  const verdict = caseWith(
    [{ kind: 'noToolCall', name: 'huaweicloud_sandbox_sign_agreement' }],
    recordings({
      http: [{ method: 'GET', path: '/check-user' }],
      toolCalls: [{ name: 'huaweicloud_sandbox_sign_agreement', args: {}, ok: true }],
    }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
  assert.match(verdict.expectations[0]!.evidence, /forbidden call happened/);
});

// The any-of toolCall name (legitimate alternative surfaces for one
// behavior, e.g. the three skill-inventory faces): any member satisfies the
// pin, no member reds with the candidates named, and the union must not leak
// permissiveness into noToolCall's exact-string negative.
test('an any-of toolCall name matches when any member surface was used', () => {
  const verdict = caseWith(
    [{ kind: 'toolCall', name: ['huaweicloud_list_skills', 'huaweicloud_list_packs', 'huaweicloud_pack_info'] }],
    recordings({ toolCalls: [{ name: 'huaweicloud_list_packs', args: {}, ok: true }] }),
  );
  assert.equal(verdict.expectations[0]!.pass, true);
  assert.equal(verdict.liveness, true);
});

test('an any-of toolCall name reds when no member was used and the evidence names the candidates', () => {
  const verdict = caseWith(
    [{ kind: 'toolCall', name: ['huaweicloud_list_skills', 'huaweicloud_list_packs'] }],
    recordings({ toolCalls: [{ name: 'huaweicloud_voucher_status', args: {}, ok: true }] }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
  assert.match(
    verdict.expectations[0]!.evidence,
    /0 matching call\(s\) for one of \[huaweicloud_list_skills, huaweicloud_list_packs\]/,
  );
});

test('an any-of toolCall name still applies the ok and args narrowing per member', () => {
  const verdict = caseWith(
    [{ kind: 'toolCall', name: ['huaweicloud_list_skills', 'huaweicloud_list_packs'], ok: true }],
    recordings({ toolCalls: [{ name: 'huaweicloud_list_packs', args: {}, ok: false }] }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
});

test('noToolCall stays an exact-string negative beside array toolCall names', () => {
  const verdict = caseWith(
    [{ kind: 'noToolCall', name: 'huaweicloud_packs_configure' }],
    recordings({ toolCalls: [{ name: 'huaweicloud_packs_configure', args: {}, ok: true }] }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
});

// The gateway args ignore-case set: product and api ids resolve
// case-insensitively at the real gateway (measured), so a pin on those keys
// folds; every unlisted key stays strictly compared.
test('gateway args fold case for the named keys only', () => {
  const exp = [
    {
      kind: 'gateway',
      tool: 'execute_api',
      args: { product: 'ECS', api: 'ListServersDetails' },
      argsIgnoreCase: ['product', 'api'],
    },
  ] as const satisfies Expectation[];
  const folded = caseWith(
    [...exp],
    recordings({
      gateway: [{ method: 'tools/call', tool: 'execute_api', args: { product: 'ecs', api: 'listserversdetails' } }],
    }),
  );
  assert.equal(folded.expectations[0]!.pass, true);

  const strict = caseWith(
    [...exp],
    recordings({
      gateway: [
        {
          method: 'tools/call',
          tool: 'execute_api',
          args: { product: 'ecs', api: 'ListServersDetails', region: 'CN-North-4' },
        },
      ],
    }),
  );
  // region is not in the pin — irrelevant; but the same folded args with
  // the flag REMOVED must miss (pins the strict default):
  const noFlag = caseWith(
    [{ kind: 'gateway', tool: 'execute_api', args: { product: 'ECS' } }],
    recordings({ gateway: [{ method: 'tools/call', tool: 'execute_api', args: { product: 'ecs' } }] }),
  );
  assert.equal(noFlag.expectations[0]!.pass, false);
});

test('gateway args ignore-case applies to scalars only, never array prefix matching', () => {
  const verdict = caseWith(
    [{ kind: 'gateway', tool: 'manage_policy', args: { lines: ['ecs:*'] }, argsIgnoreCase: ['lines'] }],
    recordings({ gateway: [{ method: 'tools/call', tool: 'manage_policy', args: { lines: ['ECS:*'] } }] }),
  );
  assert.equal(verdict.expectations[0]!.pass, false);
});
