import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfirmLanguage } from '../plugins/huaweicloud-core/src/lib/confirm-language.ts';

// The confirm-language tier ladder (the display-tier counterpart of
// approval-mode's fail-loud resolver): the operator's env pin outranks the
// model's per-call hint, which outranks the machine locale; an
// unrecognized value at any tier falls through instead of failing — a
// display concern never blocks a gated call. The matrix below pins every
// tier boundary and every soft-fall shape; the wire-level tiers (the form
// the gate actually raises) are pinned in approval-gate.test.ts's locale
// pair.

type Env = Record<string, string | undefined>;

const NO_LOCALE: Env = {}; // all four locale vars absent

function resolve(args: Record<string, unknown>, env: Env): string {
  return resolveConfirmLanguage(args, env as NodeJS.ProcessEnv);
}

test('tier 1: the operator env pin wins over both lower tiers', () => {
  assert.equal(resolve({ confirmLanguage: 'zh' }, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: 'en' }), 'en');
  assert.equal(
    resolve({ confirmLanguage: 'zh' }, { DEVKIT_CONFIRM_LANG: 'en', LC_ALL: 'zh_CN.UTF-8' }),
    'en',
    'the pin beats the hint AND the zh locale',
  );
  assert.equal(resolve({}, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: 'zh' }), 'zh');
});

test('tier 2: the model hint wins over the machine locale', () => {
  assert.equal(resolve({ confirmLanguage: 'zh' }, { ...NO_LOCALE, LC_ALL: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolve({ confirmLanguage: 'en' }, { ...NO_LOCALE, LANG: 'zh_CN.UTF-8' }), 'en');
  assert.equal(resolve({ confirmLanguage: 'zh' }, NO_LOCALE), 'zh', 'the hint works with no locale at all');
});

test('tier 3: the machine locale is the floor, any of the four variables', () => {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    assert.equal(resolve({}, { ...NO_LOCALE, [key]: 'zh_CN.UTF-8' }), 'zh', `${key} carries the zh locale`);
  }
  assert.equal(resolve({}, { ...NO_LOCALE, LC_ALL: 'en_US.UTF-8' }), 'en');
  assert.equal(resolve({}, NO_LOCALE), 'en', 'nothing set anywhere resolves to en');
});

test('soft-fall: an unrecognized pin falls through to the hint, then the locale', () => {
  assert.equal(resolve({ confirmLanguage: 'zh' }, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: 'fr' }), 'zh');
  assert.equal(resolve({ confirmLanguage: 'fr' }, { ...NO_LOCALE, LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolve({}, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: 'fr' }), 'en', 'no hint, no locale: en');
});

test('normalization: prefixes and case, not exact matches', () => {
  assert.equal(resolve({ confirmLanguage: 'zh-CN' }, NO_LOCALE), 'zh');
  assert.equal(resolve({ confirmLanguage: 'ZH_cn' }, NO_LOCALE), 'zh');
  assert.equal(resolve({ confirmLanguage: 'en-US' }, NO_LOCALE), 'en');
  assert.equal(resolve({ confirmLanguage: 'English' }, NO_LOCALE), 'en');
});

test('soft-fall: empty and whitespace-only values are unrecognized', () => {
  assert.equal(resolve({ confirmLanguage: '  ' }, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: 'zh' }), 'zh');
  assert.equal(resolve({}, { ...NO_LOCALE, DEVKIT_CONFIRM_LANG: '', LANG: 'zh_CN.UTF-8' }), 'zh');
});

test('soft-fall: a non-string confirmLanguage never throws', () => {
  for (const bad of [42, null, true, { zh: true }, ['zh']]) {
    assert.equal(resolve({ confirmLanguage: bad }, { ...NO_LOCALE, LANG: 'zh_CN.UTF-8' }), 'zh');
    assert.equal(resolve({ confirmLanguage: bad }, NO_LOCALE), 'en');
  }
});
