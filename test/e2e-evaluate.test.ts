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
