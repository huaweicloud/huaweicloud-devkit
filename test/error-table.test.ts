import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildOnboardingSteps,
  ERROR_TABLE,
  errorFromTable,
  makeError,
} from '../plugins/huaweicloud-core/src/auth/error-table.ts';

test('scenario 3 steps include obtain-aksk with console label (non-codearts)', () => {
  const steps = buildOnboardingSteps(3, { codearts: false });
  assert.ok(Array.isArray(steps) && steps.length >= 2);
  const first = steps[0]!;
  assert.equal(first.action, 'obtain-aksk');
  assert.equal(first.target, 'console');
  assert.match(first.label ?? '', /控制台/);
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
  // QA #905 Required: the import step must READ the file step 2 wrote
  // (mode:'import' → creds-import.json). mode:'mcp-config' would read the
  // CodeArts injected environment, which is empty in scenario 3.
  const importStep = steps.find((s) => s.action === 'auth_switch');
  assert.equal(importStep?.args?.mode, 'import');
  assert.equal(importStep?.args?.action, 'persist');
});

test('scenario 4 steps (import path) match guidance contract', () => {
  const steps = buildOnboardingSteps(4, { codearts: false });
  assert.ok(steps.length >= 1);
  assert.ok(steps.every((s) => typeof s.order === 'number' && typeof s.label === 'string'));
});

test('ERROR_TABLE covers the 8 #900 codes with distinct executable actions', () => {
  const codes = [
    'HDKIT_CRED_MISSING',
    'HDKIT_CRED_INVALID',
    'HDKIT_CRED_REGION_MISSING',
    'HDKIT_KOOCLI_NOT_READY',
    'HDKIT_PROJECT_ID_MISSING',
    'HDKIT_CRED_FORBIDDEN',
    'HDKIT_SYNC_SKIPPED_RUNTIME',
    'HDKIT_CRED_UNEXPECTED',
  ];
  const actions = new Set();
  for (const code of codes) {
    const e = (ERROR_TABLE as Record<string, { messageZh: string; action: string }>)[code];
    assert.ok(e, `missing table entry for ${code}`);
    assert.match(e.messageZh, /[\u4e00-\u9fff]/, `${code} messageZh must contain Chinese`);
    assert.ok(
      !/[a-z]{20,}/.test(e.messageZh.replace(/[A-Z_]+/g, '')),
      `${code} messageZh must not contain long English sentences`,
    );
    // Executable surfaces: the devkit CLI (npx …), KooCLI (hcloud …), or an MCP
    // tool call (huaweicloud_…) served by this very package.
    assert.ok(/^(npx huaweicloud-devkit|hcloud|huaweicloud_)/.test(e.action), `${code} action must be executable`);
    actions.add(e.action);
  }
  assert.equal(actions.size, codes.length, 'the 8 actions must be pairwise distinct');
  // CREDENTIAL_EXPIRED is the hcloud runner's result code (unit-4 scope), not
  // an onboarding state — it must never appear as a table key.
  assert.ok(!('CREDENTIAL_EXPIRED' in (ERROR_TABLE as Record<string, unknown>)));
});

test('makeError returns code+messageZh+action+nextStep compatibility field', () => {
  const e = makeError('HDKIT_CRED_MISSING');
  assert.equal(e.code, 'HDKIT_CRED_MISSING');
  assert.match(e.messageZh, /未配置华为云凭证/);
  assert.equal(e.action, 'npx huaweicloud-devkit auth init');
  assert.equal(e.nextStep, e.action);
  assert.ok(!/R\d+/.test(e.messageZh), 'no internal codenames in user-facing text');
});

test('errorFromTable folds detail into messageZh and degrades for unknown codes', () => {
  const withDetail = errorFromTable('HDKIT_KOOCLI_NOT_READY', '无法解析用户主目录');
  assert.equal(withDetail.code, 'HDKIT_KOOCLI_NOT_READY');
  assert.match(withDetail.messageZh, /^无法解析用户主目录\(KooCLI\(hcloud\)未安装或未就绪。\)/);
  assert.equal(withDetail.nextStep, withDetail.action);
  const unknown = errorFromTable('SOME_FUTURE_CODE', 'detail text');
  assert.equal(unknown.code, 'SOME_FUTURE_CODE');
  assert.equal(unknown.messageZh, 'detail text');
  assert.equal(unknown.action, '');
  // d11-41: even the unknown-code edge keeps top-level nextStep executable —
  // empty, never a prose sentence (the detail rides in messageZh only).
  assert.equal(unknown.nextStep, '');
  // No-detail edges: an unknown code without detail degrades to the code
  // string itself; an empty code degrades silently (no crash, empty fields).
  const unknownNoDetail = errorFromTable('SOME_FUTURE_CODE');
  assert.equal(unknownNoDetail.messageZh, 'SOME_FUTURE_CODE');
  assert.equal(unknownNoDetail.nextStep, '');
  const empty = errorFromTable('');
  assert.equal(empty.code, '');
  assert.equal(empty.messageZh, '');
  assert.equal(empty.action, '');
});

test('#900: service/validator/reconcile error surfaces carry the unified shape', () => {
  // Source-level contract: every hard-coded English error string listed in #900
  // is replaced by an errorFromTable/makeError call.
  const service = readFileSync(new URL('../plugins/huaweicloud-core/src/auth/service.ts', import.meta.url), 'utf8');
  assert.ok(!service.includes('Global credentials are not configured.'), 'service.ts must not hard-code English error');
  assert.ok(!/suppressed \(R\d+\)/.test(service), 'no internal codename in user-facing strings');
  const validator = readFileSync(
    new URL('../plugins/huaweicloud-core/src/auth/credential-validator.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    validator.includes('HDKIT_CRED_INVALID') || validator.includes('errorFromTable'),
    'validator must use the table',
  );
  const reconcile = readFileSync(new URL('../plugins/huaweicloud-core/src/auth/reconcile.ts', import.meta.url), 'utf8');
  assert.ok(!reconcile.includes("error: 'KooCLI config not found'"), 'reconcile must not return bare strings');
});
