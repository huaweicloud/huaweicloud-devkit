import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ASK_RULE_ACTION } from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';
import { fixtureDir } from './fixture-dir.ts';
import { runDoctor, runInstall } from './doctor-helpers.ts';

// The ASK approval posture through the real installer and doctor: the
// install writes the PAIR (the OpenCode permissions ask rule + the mcp
// entry's DEVKIT_APPROVAL_MODE=ask) behind the deterministic gate override
// HUAWEICLOUD_OPENCODE_ASK_RULE (the seam-override precedent — never the
// natural probe, which would flip with the host's opencode), and doctor
// evaluates the pair, failing each known mixed state in its own direction.

const ASK_LABEL = 'ASK approval posture (client prompt + server env)';

// The opencode config the installer wrote, as a mutable record the
// hand-edit tests reshape in place.
function loadOpencodeConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function saveOpencodeConfig(home: string, config: Record<string, unknown>): void {
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify(config, null, 2), 'utf8');
}

function mcpEntry(config: Record<string, unknown>): Record<string, unknown> {
  return (config.mcp as Record<string, Record<string, unknown>>)['huaweicloud-devkit']!;
}

function envOf(entry: Record<string, unknown>): Record<string, unknown> {
  return (entry.environment ?? {}) as Record<string, unknown>;
}

function ruleEntries(config: Record<string, unknown>): Array<Record<string, unknown>> {
  return (config.permissions ?? []) as Array<Record<string, unknown>>;
}

// Installs with the ask gate forced on, then returns the written config.
function installAskOn(home: string): Record<string, unknown> {
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  return loadOpencodeConfig(home);
}

test('doctor: install with the ask gate on writes both halves of the pair, and doctor PASSes', () => {
  const home = fixtureDir('hwc-ask-pair-');
  const config = installAskOn(home);
  const rules = ruleEntries(config);
  assert.deepEqual(
    rules.find((rule) => rule.action === ASK_RULE_ACTION),
    { action: ASK_RULE_ACTION, resource: '*', effect: 'ask' },
    'the exact V2 permissions entry is written',
  );
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the mcp env carries the server half');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `expected the pair to pass, got:\n${stdout}`);
});

test('doctor: an always-allow rule on the run tool FAILs (the ask contract is silently gone)', () => {
  const home = fixtureDir('hwc-ask-allow-');
  const config = installAskOn(home);
  ruleEntries(config).forEach((rule) => {
    if (rule.action === ASK_RULE_ACTION) rule.effect = 'allow';
  });
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the allow rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('"allow" (always allow)'), 'the danger is named');
  assert.ok(stdout.includes('Delete that rule or set its effect to "ask"'), 'the remediation is named');
});

test('doctor: a deny rule on the run tool FAILs (the write tool is blocked entirely)', () => {
  const home = fixtureDir('hwc-ask-deny-');
  const config = installAskOn(home);
  ruleEntries(config).forEach((rule) => {
    if (rule.action === ASK_RULE_ACTION) rule.effect = 'deny';
  });
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the deny rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('"deny" — the write tool is blocked entirely'), 'the danger is named');
});

test('doctor: the ask rule without the mcp env FAILs (the double-gate direction)', () => {
  const home = fixtureDir('hwc-ask-noenv-');
  const config = installAskOn(home);
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing env to fail, got:\n${stdout}`);
  assert.ok(
    stdout.includes('the client prompts AND the server still demands a token'),
    'the double-gate direction is named',
  );
  assert.ok(stdout.includes('npx huaweicloud-devkit install --target opencode'), 'the healable remediation is named');
});

test('doctor: the mcp env without the ask rule FAILs (the fail-open direction)', () => {
  const home = fixtureDir('hwc-ask-norule-');
  const config = installAskOn(home);
  delete config.permissions;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the server trusts a client prompt nobody shows'), 'the fail-open direction is named');
});

test('doctor: rule absent and env absent is the legitimate token-mode PASS', () => {
  const home = fixtureDir('hwc-ask-token-');
  const config = installAskOn(home);
  delete config.permissions;
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes('[PASS] ASK approval posture (token mode)'), `token mode must pass, got:\n${stdout}`);
});

test('doctor: a below-2.0 (gate-off) probe skips the section instead of failing', () => {
  const home = fixtureDir('hwc-ask-skip-');
  installAskOn(home);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  assert.ok(
    stdout.includes('[SKIP] ASK approval posture (opencode not verifiably at or above 2.0)'),
    `expected the gate-off skip, got:\n${stdout}`,
  );
});

test('install with the ask gate off writes neither half of the pair', () => {
  const home = fixtureDir('hwc-ask-off-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  const config = loadOpencodeConfig(home);
  assert.ok(config.mcp, 'the mcp entry is still written');
  assert.equal('permissions' in config, false, 'no V2 permissions rules are written');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, undefined, 'no DEVKIT_APPROVAL_MODE env is written');
});
