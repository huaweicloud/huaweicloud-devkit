import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  integrityScopeFiles,
  verifyIntegrity,
  writeIntegrityReceipt,
  INTEGRITY_RECEIPT_FILE,
  integrityReceiptPath,
} from '../plugins/huaweicloud-core/src/safety-integrity.ts';
import { fixtureDir } from './fixture-dir.ts';
import { runDoctor, runInstall, runUninstall } from './doctor-helpers.ts';

// The deployed-payload integrity receipt (the integrity unit's layer 3):
// install records a hash manifest of the deployed classifier files, doctor
// compares. The unit rows run against a scratch payload dir (no install);
// the integration rows run a REAL install into a fake HOME — the receipt
// the placement seam writes, the doctor section's PASS/FAIL/WARN verdicts,
// and the reinstall heal.

const payloadDir = (home: string): string => join(home, '.config', 'opencode', 'huaweicloud-plugins');

function stageScratchPayload(dir: string, withRules = true): void {
  mkdirSync(join(dir, 'dist', 'safety'), { recursive: true });
  mkdirSync(join(dir, 'safety', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'safety-policy.js'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'dist', 'safety', 'classify-text.js'), 'export const two = 2;\n');
  writeFileSync(join(dir, 'safety', 'policy.json'), '{"version":"0.1.0"}\n');
  if (withRules) writeFileSync(join(dir, 'safety', 'rules', 'cloud-risk-rules.json'), '{"rules":[]}\n');
}

test('the receipt records the classifier scope, sorted, and verifyIntegrity agrees with it', () => {
  const dir = fixtureDir('integrity-scratch-match-');
  stageScratchPayload(dir);
  assert.deepEqual(integrityScopeFiles(dir), [
    'dist/safety-policy.js',
    'dist/safety/classify-text.js',
    'safety/policy.json',
    'safety/rules/cloud-risk-rules.json',
  ]);
  writeIntegrityReceipt(dir);
  assert.ok(existsSync(integrityReceiptPath(dir)), 'the receipt lands beside the payload');
  const parsed = JSON.parse(readFileSync(integrityReceiptPath(dir), 'utf8')) as {
    version: number;
    files: Record<string, string>;
  };
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.files).sort(), integrityScopeFiles(dir));
  assert.equal(verifyIntegrity(dir).status, 'match');
});

test('tamper shapes drift: changed, missing, and unrecorded classifier files', () => {
  const dir = fixtureDir('integrity-scratch-tamper-');
  stageScratchPayload(dir);
  writeIntegrityReceipt(dir);
  // Changed: an agent-side rewrite of the deployed classifier.
  appendFileSync(join(dir, 'dist', 'safety-policy.js'), 'export const evil = 1;\n');
  assert.equal(verifyIntegrity(dir).status, 'mismatch');

  const dir2 = fixtureDir('integrity-scratch-missing-');
  stageScratchPayload(dir2);
  writeIntegrityReceipt(dir2);
  rmSync(join(dir2, 'safety', 'rules', 'cloud-risk-rules.json'));
  const missing = verifyIntegrity(dir2);
  assert.equal(missing.status, 'mismatch');
  assert.deepEqual(missing.status === 'mismatch' ? missing.missing : [], ['safety/rules/cloud-risk-rules.json']);

  // Unrecorded: a classifier file dropped in AFTER the receipt — no legit
  // path lands scope files without rewriting the receipt.
  const dir3 = fixtureDir('integrity-scratch-unrecorded-');
  stageScratchPayload(dir3);
  writeIntegrityReceipt(dir3);
  writeFileSync(join(dir3, 'dist', 'safety', 'risk-rule-engine.js'), 'export const evil = 1;\n');
  const unrecorded = verifyIntegrity(dir3);
  assert.equal(unrecorded.status, 'mismatch');
  assert.deepEqual(unrecorded.status === 'mismatch' ? unrecorded.unrecorded : [], ['dist/safety/risk-rule-engine.js']);
});

test('a payload without a receipt reports no-receipt, an empty dir no-payload (the WARN gate)', () => {
  const dir = fixtureDir('integrity-scratch-noreceipt-');
  stageScratchPayload(dir);
  assert.equal(verifyIntegrity(dir).status, 'no-receipt');
  // An unparseable receipt degrades to the same WARN row, never a crash.
  writeFileSync(join(dir, INTEGRITY_RECEIPT_FILE), 'not json');
  assert.equal(verifyIntegrity(dir).status, 'no-receipt');
  // No classifier files at all: nothing to verify, doctor stays silent.
  const empty = fixtureDir('integrity-scratch-empty-');
  assert.equal(verifyIntegrity(empty).status, 'no-payload');
});

test('doctor: a real install PASSES, tamper FAILs with the reinstall remediation, reinstall heals', () => {
  const home = fixtureDir('integrity-install-');
  const out = runInstall(home);
  const pd = payloadDir(home);
  assert.ok(existsSync(join(pd, INTEGRITY_RECEIPT_FILE)), 'install writes the receipt beside the payload');
  assert.match(out, /Integrity receipt -> /);
  const scope = integrityScopeFiles(pd);
  assert.ok(scope.includes('dist/safety-policy.js'), 'the classifier module is in scope');
  assert.ok(scope.includes('safety/policy.json'), 'the policy vocabulary is in scope');

  const pass = runDoctor(home);
  assert.match(pass, /\[PASS\] Safety policy integrity \(OpenCode\)/);

  // The disarm shape layer 1 denies and layer 2 canaries: a rewrite of the
  // deployed classifier that somehow landed anyway — doctor FAILs it.
  appendFileSync(join(pd, 'dist', 'safety-policy.js'), 'module.exports = {};\n');
  const fail = runDoctor(home);
  assert.match(
    fail,
    /\[FAIL\] Safety policy integrity \(OpenCode\) — 1 changed classifier file\(s\) \(dist\/safety-policy\.js\) — Run: npx huaweicloud-devkit install/,
  );

  // Reinstall heals: the receipt is rewritten over the verified payload.
  runInstall(home);
  const healed = runDoctor(home);
  assert.match(healed, /\[PASS\] Safety policy integrity \(OpenCode\)/);

  // The backward-compat row: a payload placed by an older devkit carries no
  // receipt — a WARN, never a FAIL.
  rmSync(join(pd, INTEGRITY_RECEIPT_FILE));
  const warn = runDoctor(home);
  assert.match(warn, /\[WARN\] Safety policy integrity \(OpenCode\) — integrity receipt missing/);
  assert.doesNotMatch(warn, /\[FAIL\] Safety policy integrity/);

  // Uninstall removes the receipt with the plugin dir.
  runUninstall(home);
  assert.ok(!existsSync(pd), 'the payload dir (and receipt with it) is removed');
});

test('doctor stays silent on integrity for a home with no payload', () => {
  const home = fixtureDir('integrity-empty-home-');
  const out = runDoctor(home);
  assert.doesNotMatch(out, /Safety policy integrity/);
});
