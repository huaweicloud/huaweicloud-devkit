import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachParamWarnings,
  suggestParam,
  unknownParamWarnings,
} from '../plugins/huaweicloud-core/src/lib/param-warnings.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

test('suggestParam picks the nearest declared key', () => {
  const keys = new Set(['pack', 'name']);
  assert.equal(suggestParam('pak', keys), 'pack');
  assert.equal(suggestParam('zzz_not_a_param', keys), null);
});

test('unknownParamWarnings lists key names only and caps the list', () => {
  const warnings = unknownParamWarnings({ pak: 'sandbox', secretValue: 'do-not-echo' }, new Set(['pack']));
  assert.deepEqual(warnings, [
    'Unknown parameter "pak" was ignored. Did you mean "pack"?',
    'Unknown parameter "secretValue" was ignored (no matching parameter).',
  ]);
  assert.ok(!warnings.join('\n').includes('do-not-echo'), 'values never reach the warning');
});

test('attachParamWarnings merges without clobbering an existing array', () => {
  assert.deepEqual(attachParamWarnings({ ok: true }, ['x']), { ok: true, warnings: ['x'] });
  assert.deepEqual(attachParamWarnings({ ok: true, warnings: ['a'] }, ['x']), { ok: true, warnings: ['a', 'x'] });
  assert.deepEqual(attachParamWarnings({ ok: true, warnings: 'kept' }, ['x']), {
    ok: true,
    warnings: 'kept',
    paramWarnings: ['x'],
  });
  assert.deepEqual(attachParamWarnings({ ok: true }, []), { ok: true });
});

test('a typo of an optional parameter now carries a warning', async () => {
  const typoArgs = { pak: 'sandbox' } as unknown as Parameters<typeof callTool>[1];
  const typo = (await callTool('huaweicloud_list_skills', typoArgs)) as {
    warnings?: string[];
    count?: number;
  };
  assert.equal(typo.count, 24, 'the #530 leniency still accepts the call');
  assert.ok(typo.warnings?.some((warning) => warning.includes('"pak"') && warning.includes('"pack"')));

  const valid = (await callTool('huaweicloud_list_skills', { pack: 'sandbox' })) as { warnings?: string[] };
  assert.equal(valid.warnings, undefined, 'a declared key stays quiet');

  const vendor = (await callTool('huaweicloud_list_packs', { vendorConfirmed: 'test' })) as { warnings?: string[] };
  assert.equal(vendor.warnings, undefined, 'the central vendor gate key is not a typo');
});
