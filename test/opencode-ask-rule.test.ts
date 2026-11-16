import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERMISSION_RULE_RESOURCE,
  allowRuleActions,
  applyAllowPermissionRules,
  applyAllowPermissionRulesV1,
  askRuleShapeFor,
  opencodeAskRuleVersionSupported,
  readPermissionRules,
  readPermissionRulesV1,
  removeAllowPermissionRules,
  removeAllowPermissionRulesV1,
  removeAskPermissionRules,
  removeAskPermissionRulesV1,
} from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';

// Pure client-rule logic (lib/opencode-ask-rule.ts): the ownership contract
// is add-only-if-absent per rule and value-exact on removal, one exact allow
// rule per roster tool, plus the doctor's reading of the posture. These units
// pin every branch the CLI integration cannot reach deterministically
// (multi-rule partial coverage, user-owned entries, non-array shapes,
// last-match-wins inspection, the legacy ask migration).

const ROSTER = allowRuleActions();
const A = 'huaweicloud-devkit_tool_a';
const B = 'huaweicloud-devkit_tool_b';
const C = 'huaweicloud-devkit_tool_c';
const OTHER = { action: 'other-server_other_tool', resource: PERMISSION_RULE_RESOURCE, effect: 'deny' };

function allow(action: string): Record<string, unknown> {
  return { action, resource: PERMISSION_RULE_RESOURCE, effect: 'allow' };
}

function ask(action: string): Record<string, unknown> {
  return { action, resource: PERMISSION_RULE_RESOURCE, effect: 'ask' };
}

// ── V2: the `permissions` array form ──

test('applyAllowPermissionRules writes one exact allow rule per roster tool on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applyAllowPermissionRules(config);
  assert.deepEqual(result, { changed: true, skipped: [], shapeUnreadable: false });
  assert.deepEqual(
    config.permissions,
    ROSTER.map((action) => allow(action)),
    'the roster drives one exact rule per tool',
  );
  assert.equal(ROSTER.length, 1, 'roster length is 1 at this PR; the mechanism is N-ready');
});

test('the N-rule set is written when the roster carries several tools', () => {
  const config: Record<string, unknown> = {};
  const result = applyAllowPermissionRules(config, [A, B, C]);
  assert.deepEqual(result, { changed: true, skipped: [], shapeUnreadable: false });
  assert.deepEqual(config.permissions, [allow(A), allow(B), allow(C)]);
});

test('partial coverage: an action that already carries anything else is skipped by name', () => {
  const userDeny = { action: A, resource: PERMISSION_RULE_RESOURCE, effect: 'deny' };
  const userResource = { action: B, resource: '/tmp/**', effect: 'allow' };
  const config = { permissions: [userDeny, userResource, OTHER] };
  const result = applyAllowPermissionRules(config, [A, B, C]);
  assert.deepEqual(result, { changed: true, skipped: [A, B], shapeUnreadable: false });
  assert.deepEqual(
    config.permissions,
    [userDeny, userResource, OTHER, allow(C)],
    'user rules survive untouched and only the missing action is appended last',
  );
});

test('a reinstall over our own rules is a no-op, never a false user-owned skip', () => {
  const config = { permissions: [allow(A), allow(B)] };
  const result = applyAllowPermissionRules(config, [A, B]);
  assert.deepEqual(result, { changed: false, skipped: [], shapeUnreadable: false });
  assert.deepEqual(config.permissions, [allow(A), allow(B)], 'no duplicate rows');
});

test('a non-array permissions shape is skipped untouched', () => {
  const config = { permissions: 'allow' };
  const result = applyAllowPermissionRules(config);
  assert.deepEqual(result, { changed: false, skipped: [], shapeUnreadable: true });
  assert.equal(config.permissions, 'allow', 'the user’s shape is never converted');
});

test('removeAllowPermissionRules deletes only value-exact allow rows and prunes the emptied array', () => {
  const userDeny = { action: A, resource: PERMISSION_RULE_RESOURCE, effect: 'deny' };
  const userResource = { action: B, resource: '/tmp/**', effect: 'allow' };
  const config = { permissions: [allow(A), userDeny, allow(B), userResource, OTHER] };
  assert.equal(removeAllowPermissionRules(config, [A, B]), true);
  assert.deepEqual(config.permissions, [userDeny, userResource, OTHER], 'user-modified rows survive');
});

test('removal prunes the permissions key only when OUR removals emptied it', () => {
  const config = { permissions: ROSTER.map((action) => allow(action)) };
  assert.equal(removeAllowPermissionRules(config), true);
  assert.equal('permissions' in config, false, 'the array the rules emptied is gone');

  const empty = { permissions: [] };
  assert.equal(removeAllowPermissionRules(empty), false, 'a pre-existing empty array is left alone');
  assert.deepEqual(empty.permissions, []);
});

test('removal is a no-op without an array to read', () => {
  assert.equal(removeAllowPermissionRules({}), false);
  assert.equal(removeAllowPermissionRules({ permissions: 'allow' }), false, 'the scalar shape is the user’s');
});

test('removeAskPermissionRules migrates only the exact legacy ask rows', () => {
  const userAskResource = { action: A, resource: '/tmp/**', effect: 'ask' };
  const config = { permissions: [ask(A), ask(B), userAskResource, allow(C), OTHER] };
  assert.equal(removeAskPermissionRules(config, [A, B, C]), true);
  assert.deepEqual(
    config.permissions,
    [userAskResource, allow(C), OTHER],
    'legacy rows go; user rows and the allow set stay',
  );
});

test('the migration leaves a config that never carried the old posture untouched', () => {
  const config = { permissions: [allow(A), OTHER] };
  assert.equal(removeAskPermissionRules(config, [A, B]), false);
  assert.deepEqual(config.permissions, [allow(A), OTHER]);
});

// ── V1: the `permission` object form (opencode 1.19.0 – 1.x) ──

test('applyAllowPermissionRulesV1 writes one exact allow key per roster tool on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applyAllowPermissionRulesV1(config, [A, B]);
  assert.deepEqual(result, { changed: true, skipped: [], shapeUnreadable: false });
  assert.deepEqual(config.permission, { [A]: 'allow', [B]: 'allow' });
});

test('the V1 append lands last, so findLast makes it effective over an earlier wildcard', () => {
  const config = { permission: { '*': 'allow', bash: 'allow' } };
  const result = applyAllowPermissionRulesV1(config, [A]);
  assert.deepEqual(result, { changed: true, skipped: [], shapeUnreadable: false });
  assert.deepEqual(Object.keys(config.permission as Record<string, unknown>), ['*', 'bash', A], 'our key is last');
});

test('a V1 value that is not allow is user-owned and skipped by name; allow is the no-op state', () => {
  for (const value of ['deny', 'ask', { '*': 'ask' }]) {
    const config = { permission: { [A]: value } };
    const result = applyAllowPermissionRulesV1(config, [A, B]);
    assert.deepEqual(result, { changed: true, skipped: [A], shapeUnreadable: false }, `value ${JSON.stringify(value)}`);
    assert.equal((config.permission as Record<string, unknown>)[A], value, 'the user’s value survives');
    assert.equal((config.permission as Record<string, unknown>)[B], 'allow', 'the missing action is written');
  }
  const covered = { permission: { [A]: 'allow' } };
  assert.deepEqual(applyAllowPermissionRulesV1(covered, [A]), {
    changed: false,
    skipped: [],
    shapeUnreadable: false,
  });
});

test('a scalar-shaped permission is skipped untouched (the global posture is the user’s)', () => {
  const config = { permission: 'allow' };
  const result = applyAllowPermissionRulesV1(config, [A]);
  assert.deepEqual(result, { changed: false, skipped: [], shapeUnreadable: true });
  assert.equal(config.permission, 'allow', 'the user’s shape is never converted');
});

test('removeAllowPermissionRulesV1 deletes only allow keys and prunes the emptied object', () => {
  const config = { permission: { '*': 'deny', [A]: 'allow', [B]: 'deny' } };
  assert.equal(removeAllowPermissionRulesV1(config, [A, B]), true);
  assert.deepEqual(config.permission, { '*': 'deny', [B]: 'deny' }, 'user values survive value-exact removal');

  const emptied = { permission: { [A]: 'allow' } };
  assert.equal(removeAllowPermissionRulesV1(emptied, [A]), true);
  assert.equal('permission' in emptied, false, 'the object our removal emptied is gone');
});

test('removeAskPermissionRulesV1 migrates only the exact legacy ask keys', () => {
  const config = { permission: { '*': 'deny', [A]: 'ask', [B]: 'deny' } };
  assert.equal(removeAskPermissionRulesV1(config, [A, B]), true);
  assert.deepEqual(config.permission, { '*': 'deny', [B]: 'deny' });

  const empty = { permission: {} };
  assert.equal(removeAskPermissionRulesV1(empty, [A]), false, 'a pre-existing empty object is left alone');
  assert.deepEqual(empty.permission, {});
});

test('the legacy posture is migrated away in BOTH shapes on one config', () => {
  const config: Record<string, unknown> = {
    permissions: [ask(A), allow(B)],
    permission: { [A]: 'ask', '*': 'allow' },
  };
  const v2 = removeAskPermissionRules(config, [A, B]);
  const v1 = removeAskPermissionRulesV1(config, [A, B]);
  assert.equal(v2 || v1, true);
  assert.deepEqual(config.permissions, [allow(B)], 'the V2 residue is gone');
  assert.deepEqual(config.permission, { '*': 'allow' }, 'the V1 residue is gone and the user key survives');
});

test('the accepted edge: a user-authored same-shape ask row is migration collateral (both shapes)', () => {
  // Indistinguishable from the devkit-written legacy posture, so the
  // migration removes it together with our own — the same accepted edge the
  // skills-tree seam records.
  const v2: Record<string, unknown> = { permissions: [ask(A)] };
  assert.equal(removeAskPermissionRules(v2, [A, B]), true);
  assert.equal('permissions' in v2, false, 'the emptied array is pruned');

  const v1: Record<string, unknown> = { permission: { [A]: 'ask' } };
  assert.equal(removeAskPermissionRulesV1(v1, [A, B]), true);
  assert.equal('permission' in v1, false, 'the emptied object is pruned');
});

test('the accepted edge: a user-authored same-shape allow row is removal collateral (both shapes)', () => {
  const v2: Record<string, unknown> = { permissions: [allow(A)] };
  assert.equal(removeAllowPermissionRules(v2, [A, B]), true);
  assert.equal('permissions' in v2, false, 'the emptied array is pruned');

  const v1: Record<string, unknown> = { permission: { [A]: 'allow' } };
  assert.equal(removeAllowPermissionRulesV1(v1, [A, B]), true);
  assert.equal('permission' in v1, false, 'the emptied object is pruned');
});

// ── Reading the posture (the doctor's half) ──

test('readPermissionRules reads every readable effect per roster action', () => {
  for (const effect of ['allow', 'deny'] as const) {
    const config = { permissions: [{ action: A, resource: PERMISSION_RULE_RESOURCE, effect }] };
    const reading = readPermissionRules(config, [A]);
    assert.equal(reading.sectionUnreadable, false);
    assert.deepEqual(reading.rules, [{ action: A, state: effect, askResidue: false }]);
  }
  const askReading = readPermissionRules({ permissions: [ask(A)] }, [A]);
  assert.deepEqual(askReading.rules, [{ action: A, state: 'ask', askResidue: true }], 'ask is the migration residue');
});

test('a missing rule reads absent, and a multi-action reading shows every gap', () => {
  const reading = readPermissionRules({ permissions: [allow(A)] }, [A, B, C]);
  assert.deepEqual(
    reading.rules.map((rule) => [rule.action, rule.state]),
    [
      [A, 'allow'],
      [B, 'absent'],
      [C, 'absent'],
    ],
    'partial coverage names each missing action',
  );
  assert.equal(readPermissionRules({}, [A]).rules[0]?.state, 'absent', 'no permissions key');
});

test('readPermissionRules flags ask residue even when a later allow row wins', () => {
  const shadowed = { permissions: [ask(A), allow(A)] };
  assert.deepEqual(readPermissionRules(shadowed, [A]).rules, [{ action: A, state: 'allow', askResidue: true }]);
});

test('a deny anywhere on the action reads deny (a bricked call, even shadowed)', () => {
  const shadowed = {
    permissions: [{ action: A, resource: '/tmp/**', effect: 'deny' }, allow(A)],
  };
  assert.equal(readPermissionRules(shadowed, [A]).rules[0]?.state, 'deny');
});

test('a user rule on another resource reads user-other, never a silent gap', () => {
  const reading = readPermissionRules({ permissions: [{ action: A, resource: '/tmp/**', effect: 'allow' }] }, [A]);
  assert.deepEqual(reading.rules, [{ action: A, state: 'user-other', askResidue: false }]);
});

test('an unknown effect or a non-array section reads unverifiable (foreign)', () => {
  const unknown = { permissions: [{ action: A, resource: PERMISSION_RULE_RESOURCE, effect: 'maybe' }] };
  assert.equal(readPermissionRules(unknown, [A]).rules[0]?.state, 'foreign');

  const scalar = { permissions: { action: A, effect: 'allow' } };
  const reading = readPermissionRules(scalar, [A]);
  assert.equal(reading.sectionUnreadable, true);
  assert.deepEqual(reading.rules, [{ action: A, state: 'foreign', askResidue: false }], 'the section names itself');
});

test('readPermissionRulesV1 maps each bare value and reports the unreadable shapes', () => {
  assert.deepEqual(readPermissionRulesV1({ permission: { [A]: 'allow' } }, [A]).rules, [
    { action: A, state: 'allow', askResidue: false },
  ]);
  assert.deepEqual(readPermissionRulesV1({ permission: { [A]: 'ask' } }, [A]).rules, [
    { action: A, state: 'ask', askResidue: true },
  ]);
  assert.deepEqual(readPermissionRulesV1({ permission: { [A]: 'deny' } }, [A]).rules, [
    { action: A, state: 'deny', askResidue: false },
  ]);
  assert.deepEqual(readPermissionRulesV1({}, [A]).rules, [{ action: A, state: 'absent', askResidue: false }]);
  assert.deepEqual(readPermissionRulesV1({ permission: { other_tool: 'allow' } }, [A]).rules, [
    { action: A, state: 'absent', askResidue: false },
  ]);
  assert.deepEqual(readPermissionRulesV1({ permission: { [A]: { '*': 'ask' } } }, [A]).rules, [
    { action: A, state: 'foreign', askResidue: false },
  ]);
  const scalar = readPermissionRulesV1({ permission: 'allow' }, [A]);
  assert.equal(scalar.sectionUnreadable, true);
  assert.deepEqual(scalar.rules, [{ action: A, state: 'foreign', askResidue: false }]);
});

test('opencodeAskRuleVersionSupported pins the 2.0 floor and the unknown polarity', () => {
  assert.equal(opencodeAskRuleVersionSupported('2.0.0'), true, 'the V2 permissions array floor');
  assert.equal(opencodeAskRuleVersionSupported('v2.2.7'), true, 'the measured version');
  assert.equal(opencodeAskRuleVersionSupported('2.9.1'), true);
  assert.equal(opencodeAskRuleVersionSupported('1.19.0'), false, 'below the V2 shape');
  assert.equal(opencodeAskRuleVersionSupported('1.9'), false);
  assert.equal(opencodeAskRuleVersionSupported('garbage'), false, 'unparsable');
  assert.equal(opencodeAskRuleVersionSupported('opencode 2.2.7'), false, 'the probe must extract, not pass raw output');
  assert.equal(opencodeAskRuleVersionSupported('2'), false, 'unparsable per the anchored shape');
  assert.equal(opencodeAskRuleVersionSupported(null), false, 'absent/unparsable polarity is skip');
});

test('askRuleShapeFor pins both measured floors and the unknown polarity', () => {
  assert.equal(askRuleShapeFor('2.0.0'), 'v2-array', 'the V2 permissions array floor');
  assert.equal(askRuleShapeFor('v2.2.7'), 'v2-array', 'the measured V2');
  assert.equal(askRuleShapeFor('v9.9.9'), 'v2-array');
  assert.equal(askRuleShapeFor('1.19.0'), 'v1-object', 'the source-verified V1');
  assert.equal(askRuleShapeFor('v1.30.5'), 'v1-object');
  assert.equal(askRuleShapeFor('1.18.9'), 'unsupported', 'below the V1 floor');
  assert.equal(askRuleShapeFor('1.9'), 'unsupported', 'unparsable per the anchored shape');
  assert.equal(askRuleShapeFor('opencode 2.2.7'), 'unsupported', 'the probe must extract, not pass raw output');
  assert.equal(askRuleShapeFor(null), 'unsupported', 'absent/unparsable polarity is skip');
});
