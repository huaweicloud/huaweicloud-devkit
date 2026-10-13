// test/guidance.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOnboardingSteps, ERROR_TABLE, makeError } from '../plugins/huaweicloud-core/src/auth/guidance.mjs';

test('scenario 3 steps include obtain-aksk with console label (non-codearts)', () => {
  const steps = buildOnboardingSteps(3, { codearts: false });
  assert.ok(Array.isArray(steps) && steps.length >= 2);
  const first = steps[0];
  assert.equal(first.action, 'obtain-aksk');
  assert.equal(first.target, 'console');
  assert.match(first.label, /控制台/);
  assert.ok(first.order === 1);
  for (const s of steps) {
    assert.ok(typeof s.order === 'number');
    assert.ok(typeof s.label === 'string' && s.label.length > 0);
    assert.ok(typeof s.action === 'string');
  }
});

test('scenario 3 codearts variant has write-import + auth_switch persist steps', () => {
  const steps = buildOnboardingSteps(3, { codearts: true });
  const actions = new Set(steps.map((s) => s.action));
  assert.ok(actions.has('obtain-aksk'));
  assert.ok(actions.has('write-import'));
  assert.ok(actions.has('auth_switch'));
});

test('scenario 4 steps (import path) match guidance contract', () => {
  const steps = buildOnboardingSteps(4, { codearts: false });
  assert.ok(steps.length >= 1);
  assert.ok(steps.every((s) => typeof s.order === 'number' && typeof s.label === 'string'));
});

test('ERROR_TABLE covers the 6 #900 codes with distinct executable actions', () => {
  const codes = [
    'HDKIT_CRED_MISSING',
    'HDKIT_CRED_INVALID',
    'HDKIT_CRED_REGION_MISSING',
    'HDKIT_KOOCLI_NOT_READY',
    'HDKIT_PROJECT_ID_MISSING',
    'HDKIT_CRED_FORBIDDEN',
  ];
  const actions = new Set();
  for (const code of codes) {
    const e = ERROR_TABLE[code];
    assert.ok(e, `missing table entry for ${code}`);
    assert.match(e.messageZh, /[\u4e00-\u9fff]/, `${code} messageZh must contain Chinese`);
    assert.ok(
      !/[a-z]{20,}/.test(e.messageZh.replace(/[A-Z_]+/g, '')),
      `${code} messageZh must not contain long English sentences`,
    );
    assert.ok(
      e.action.startsWith('npx huaweicloud-devkit') || e.action.startsWith('hcloud'),
      `${code} action must be executable`,
    );
    actions.add(e.action);
  }
  assert.equal(actions.size, codes.length, 'the 6 actions must be pairwise distinct');
});

test('makeError returns code+messageZh+action+nextStep compatibility field', () => {
  const e = makeError('HDKIT_CRED_MISSING');
  assert.equal(e.code, 'HDKIT_CRED_MISSING');
  assert.match(e.messageZh, /未配置华为云凭证/);
  assert.equal(e.action, 'npx huaweicloud-devkit auth init');
  assert.equal(e.nextStep, e.action);
  assert.ok(!/R\d+/.test(e.messageZh), 'no internal codenames in user-facing text');
});
