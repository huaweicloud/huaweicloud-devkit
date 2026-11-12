import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASK_RULE_ACTION,
  ASK_RULE_RESOURCE,
  applyAskPermissionRule,
  inspectAskPermissionRule,
  opencodeAskRuleVersionSupported,
  removeAskPermissionRule,
} from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';

// Pure ask-rule logic (lib/opencode-ask-rule.ts), modeled on the seam
// test's Part A: the ownership contract is add-only-if-absent on write and
// value-exact on removal; these units pin every branch the CLI integration
// cannot reach deterministically (user entries, non-array shapes,
// last-match-wins inspection, the version floor's polarity).

const ourRule = { action: ASK_RULE_ACTION, resource: ASK_RULE_RESOURCE, effect: 'ask' };

test('applyAskPermissionRule creates the single-entry array on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(config.permissions, [ourRule]);
});

test('a user entry on the ask action survives the write, whatever its effect', () => {
  for (const effect of ['allow', 'deny', 'ask']) {
    const config = { permissions: [{ action: ASK_RULE_ACTION, resource: '*', effect }] };
    const result = applyAskPermissionRule(config);
    assert.deepEqual(result, { changed: false, skipped: true }, `effect ${effect} is user-owned`);
    assert.deepEqual(config.permissions, [{ action: ASK_RULE_ACTION, resource: '*', effect }]);
  }
});

test('the appended entry lands last, so last-matching-rule-wins makes it effective', () => {
  const userRule = { action: 'other-server_other_tool', resource: '*', effect: 'deny' };
  const config = { permissions: [userRule] };
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(config.permissions, [userRule, ourRule], 'our entry is the last one');
});

test('a non-array permissions shape is skipped untouched', () => {
  const config = { permissions: 'ask' };
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: false, skipped: true });
  assert.equal(config.permissions, 'ask', 'the user’s shape is never converted');
});

test('removeAskPermissionRule deletes only value-exact matches and prunes the emptied array', () => {
  const userEffect = { action: ASK_RULE_ACTION, resource: '*', effect: 'allow' };
  const otherAction = { action: 'other-server_other_tool', resource: '*', effect: 'ask' };
  const config = { permissions: [{ ...ourRule }, userEffect, otherAction] };
  const changed = removeAskPermissionRule(config);
  assert.equal(changed, true);
  assert.deepEqual(config.permissions, [userEffect, otherAction], 'user-modified and other-action entries survive');
});

test('removal prunes the permissions key only when OUR removals emptied it', () => {
  const config = { permissions: [{ ...ourRule }] };
  assert.equal(removeAskPermissionRule(config), true);
  assert.equal('permissions' in config, false, 'the array the rule emptied is gone');
});

test('a pre-existing empty array is left alone (no phantom change)', () => {
  const config = { permissions: [] };
  assert.equal(removeAskPermissionRule(config), false);
  assert.deepEqual(config.permissions, []);
});

test('removal is a no-op without an array to read', () => {
  assert.equal(removeAskPermissionRule({}), false);
  assert.equal(removeAskPermissionRule({ permissions: 'ask' }), false, 'the scalar shape is the user’s');
});

test('the full write/remove cycle restores the pre-rule content', () => {
  const original = { permissions: [{ action: 'user_tool', resource: '*', effect: 'deny' }] };
  const config = structuredClone(original);
  applyAskPermissionRule(config);
  assert.equal(removeAskPermissionRule(config), true);
  assert.deepEqual(config, original);
});

test('the accepted edge: a user-authored same-shape rule predating the write is removed with it', () => {
  const config = { permissions: [{ ...ourRule }] };
  assert.equal(removeAskPermissionRule(config), true);
  assert.equal('permissions' in config, false);
});

test('inspectAskPermissionRule reads the LAST matching entry (last-match-wins)', () => {
  // apply does NOT append when an entry on the action exists, so the
  // multi-entry case is constructed by hand — exactly the shape a user's
  // own edits produce.
  const both = { permissions: [{ ...ourRule, effect: 'allow' }, { ...ourRule }] };
  assert.equal(inspectAskPermissionRule(both), 'ask', 'the last entry wins');
  const reversed = { permissions: [{ ...ourRule }, { ...ourRule, effect: 'deny' }] };
  assert.equal(inspectAskPermissionRule(reversed), 'deny', 'the last entry wins');
});

test('inspectAskPermissionRule reports each readable effect', () => {
  for (const effect of ['ask', 'allow', 'deny'] as const) {
    assert.equal(inspectAskPermissionRule({ permissions: [{ ...ourRule, effect }] }), effect);
  }
});

test('inspectAskPermissionRule reports absent for no matching entry', () => {
  assert.equal(inspectAskPermissionRule({}), 'absent', 'no permissions key');
  assert.equal(inspectAskPermissionRule({ permissions: [] }), 'absent', 'empty array');
  assert.equal(
    inspectAskPermissionRule({ permissions: [{ action: 'other_tool', resource: '*', effect: 'allow' }] }),
    'absent',
    'only other actions',
  );
});

test('inspectAskPermissionRule reports foreign for unreadable postures', () => {
  assert.equal(inspectAskPermissionRule({ permissions: 'allow' }), 'foreign', 'non-array permissions');
  assert.equal(
    inspectAskPermissionRule({ permissions: [{ ...ourRule, effect: 'maybe' }] }),
    'foreign',
    'an effect outside the allow/ask/deny vocabulary is unreadable',
  );
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
