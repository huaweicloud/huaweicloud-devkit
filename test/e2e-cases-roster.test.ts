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
