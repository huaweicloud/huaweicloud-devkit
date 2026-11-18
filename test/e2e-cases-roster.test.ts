import assert from 'node:assert/strict';
import test from 'node:test';

import { PACK_OF } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { ALL_CASES } from './e2e/cases/index.ts';

// Every toolCall / noToolCall expectation names a real tool in the roster
// (PACK_OF, the product's ownership truth). noToolCall passes on zero
// hits by design, so a typo'd or renamed name is a vacuously-green pin
// with no runtime error to surface it — the vendor-ambiguity guard alone
// carries 13 hand-written names, and the case comments invite more
// ("EXTEND the family"). Same doctrine as core.ts's roster-derived
// TOTAL_TOOLS: names derive from PACK_OF, never from hand lists that
// silently drift. The case assembly itself is the shared cases/index.ts
// module the runner imports, so this guard can never lag the suite; the
// count assertion pins the total against the docs/workflow numbers
// (33) so count drift fails loudly instead of silently re-budgeting the
// nightly.
test('every toolCall/noToolCall expectation names a tool that exists in the roster', () => {
  const offenders: string[] = [];
  for (const caseDef of ALL_CASES) {
    for (const exp of caseDef.expect) {
      if (exp.kind === 'toolCall' || exp.kind === 'noToolCall') {
        // A toolCall name may be an any-of array (legitimate alternative
        // surfaces for one behavior). Every member must be a real tool:
        // an unknown member is exactly the vacuously-green pin this guard
        // exists to catch — iterating the members, never the array's
        // coerced toString, keeps the guard load-bearing under the union.
        const names = Array.isArray(exp.name) ? exp.name : [exp.name];
        for (const name of names) {
          if (!(name in PACK_OF)) offenders.push(`${caseDef.id}: ${name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'unknown tool names would make their pins vacuously green');
});

test('the suite ships the case count the docs and workflow budget for', () => {
  assert.equal(ALL_CASES.length, 33, 'docs/e2e-testing-design.md and the nightly workflow budget for 33 cases');
});

// The approval-posture contract (E2eCase.approvalMode's doctrine comment):
// the positive case IS the token chain, and the token chain is the only
// positive approval flow a headless run can complete — the ask posture's
// confirmation is an interactive client prompt with no headless approver
// (measured on opencode 1.19.0: an ask-gated MCP call never executes).
// The negative case deliberately keeps the natural (ask) posture: its
// teaching — wait for the user — is the ask note's surface. Dropping the
// pin reverts the positive case to red-by-construction (the plan tool's
// ask-mode note contradicts the prompt's token teaching, measured 4/4
// stalled attempts across the 2026-11-13/14 nightlies).
// The autoConfirm pin rides along: without the simulated terminal
// confirmation the run call rejects with USER_CONFIRMATION_REQUIRED
// (measured on the 2026-11-14 nightly — plan→run both green, execution
// red), and the positive case's hcloud execution expectation cannot pass.
test('the positive approval case pins the token posture; the negative keeps the natural one', () => {
  const positive = ALL_CASES.find((c) => c.id === 'core-approval-positive');
  const negative = ALL_CASES.find((c) => c.id === 'core-approval-negative');
  assert.ok(positive, 'core-approval-positive exists');
  assert.ok(negative, 'core-approval-negative exists');
  assert.equal(positive?.approvalMode, 'token', 'the token contract needs the token posture');
  assert.equal(
    positive?.autoConfirmApprovals,
    true,
    'the out-of-band confirm is the human half the headless run cannot do',
  );
  assert.equal(negative?.approvalMode, undefined, 'the negative case runs the installer-natural posture');
  assert.equal(negative?.autoConfirmApprovals, undefined, 'the negative case must never get a confirmed user');
});
