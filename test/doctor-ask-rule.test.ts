import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ASK_RULE_ACTION } from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';
import { fixtureDir } from './fixture-dir.ts';
import { runDoctor, runInstall } from './doctor-helpers.ts';
import { seedStoreIn } from './opencode-saved-perms-harness.ts';

// The ASK approval posture through the real installer and doctor: the
// install writes the PAIR (the OpenCode permissions ask rule + the mcp
// entry's DEVKIT_APPROVAL_MODE=ask) behind the deterministic gate override
// HUAWEICLOUD_OPENCODE_ASK_RULE (the seam-override precedent — never the
// natural probe, which would flip with the host's opencode), and doctor
// evaluates the pair, failing each known mixed state in its own direction.

const ASK_LABEL = 'ASK approval posture (client rule + server gate)';

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

test('doctor: an always-allow rule on the run tool FAILs (drift from the installer pair)', () => {
  const home = fixtureDir('hwc-ask-allow-');
  const config = installAskOn(home);
  ruleEntries(config).forEach((rule) => {
    if (rule.action === ASK_RULE_ACTION) rule.effect = 'allow';
  });
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the allow rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the permissions rule for the run tool is "allow"'), 'the drift is named');
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

test('doctor: the ask rule without the mcp env FAILs (drift from the installer pair)', () => {
  const home = fixtureDir('hwc-ask-noenv-');
  const config = installAskOn(home);
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing env to fail, got:\n${stdout}`);
  assert.ok(
    stdout.includes('DEVKIT_APPROVAL_MODE=ask is missing from the mcp entry'),
    'the double-gate direction is named',
  );
  assert.ok(stdout.includes('npx huaweicloud-devkit install --target opencode'), 'the healable remediation is named');
});

test('doctor: the mcp env without the ask rule FAILs (the drifted pair direction)', () => {
  const home = fixtureDir('hwc-ask-norule-');
  const config = installAskOn(home);
  delete config.permissions;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the pair has drifted from what this installer writes'), 'the drift is named');
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

test('doctor: a below-floor (gate-off) probe skips the section instead of failing', () => {
  const home = fixtureDir('hwc-ask-skip-');
  installAskOn(home);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  assert.ok(
    stdout.includes('[SKIP] ASK approval posture (opencode not verifiably at or above 1.19.0)'),
    `expected the gate-off skip, got:\n${stdout}`,
  );
});

test('install with the ask gate off writes neither half of the pair', () => {
  const home = fixtureDir('hwc-ask-off-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  const config = loadOpencodeConfig(home);
  assert.ok(config.mcp, 'the mcp entry is still written');
  assert.equal('permissions' in config, false, 'no V2 permissions rules are written');
  assert.equal(
    (config.permission as Record<string, unknown> | undefined)?.[ASK_RULE_ACTION],
    undefined,
    'no V1 ask key is written (the skills-tree seam’s own permission keys may coexist)',
  );
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, undefined, 'no DEVKIT_APPROVAL_MODE env is written');
});

// ── The V1 shape: the `permission` object form (opencode 1.19.0 – 1.x) ──
// HUAWEICLOUD_OPENCODE_ASK_RULE=v1 forces the shape deterministically (the
// natural probe on a host without opencode cannot), and the env half is
// identical across shapes — so the V1 matrix re-runs the V2 posture logic
// against the object form.

function installAskV1(home: string): Record<string, unknown> {
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  return loadOpencodeConfig(home);
}

function v1Permission(config: Record<string, unknown>): Record<string, unknown> {
  return config.permission as Record<string, unknown>;
}

test('doctor: the v1 gate writes the permission key + env pair, and doctor PASSes', () => {
  const home = fixtureDir('hwc-ask-v1-pair-');
  const config = installAskV1(home);
  assert.equal(v1Permission(config)[ASK_RULE_ACTION], 'ask', 'the V1 permission key carries the client half');
  assert.equal('permissions' in config, false, 'the V2 array is not written on the v1 shape');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the mcp env carries the server half');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `expected the v1 pair to pass, got:\n${stdout}`);
});

test('doctor: a v1 allow value FAILs with the key-shaped remediation (the ask contract is silently gone)', () => {
  const home = fixtureDir('hwc-ask-v1-allow-');
  const config = installAskV1(home);
  v1Permission(config)[ASK_RULE_ACTION] = 'allow';
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the v1 allow to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the permission value for the run tool is "allow"'), 'the drift is named');
  assert.ok(stdout.includes('Delete that key or set its value to "ask"'), 'the shape-accurate remediation is named');
});

test('doctor: a v1 deny value FAILs (the write tool is blocked entirely)', () => {
  const home = fixtureDir('hwc-ask-v1-deny-');
  const config = installAskV1(home);
  v1Permission(config)[ASK_RULE_ACTION] = 'deny';
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the v1 deny to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('"deny" — the write tool is blocked entirely'), 'the danger is named');
});

test('doctor: the v1 key without the mcp env FAILs (the drifted pair direction)', () => {
  const home = fixtureDir('hwc-ask-v1-noenv-');
  const config = installAskV1(home);
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing env to fail, got:\n${stdout}`);
  assert.ok(
    stdout.includes('DEVKIT_APPROVAL_MODE=ask is missing from the mcp entry'),
    'the double-gate direction is named',
  );
});

test('doctor: the v1 env without the key FAILs (the drifted pair direction)', () => {
  const home = fixtureDir('hwc-ask-v1-norule-');
  const config = installAskV1(home);
  delete config.permission;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing key to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the pair has drifted from what this installer writes'), 'the drift is named');
});

test('doctor: v1 key and env both absent is the legitimate token-mode PASS', () => {
  const home = fixtureDir('hwc-ask-v1-token-');
  const config = installAskV1(home);
  delete config.permission;
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes('[PASS] ASK approval posture (token mode)'), `token mode must pass, got:\n${stdout}`);
});

test('doctor: a v1 pattern-map value is a foreign SKIP, never a misread posture', () => {
  const home = fixtureDir('hwc-ask-v1-foreign-');
  const config = installAskV1(home);
  v1Permission(config)[ASK_RULE_ACTION] = { '*': 'ask' };
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes('[SKIP] ASK approval posture'), `expected the foreign skip, got:\n${stdout}`);
  assert.ok(stdout.includes('not a bare ask/allow/deny string'), 'the shape-accurate skip reason is named');
});

test('install honors a user-owned v1 key: add-only-if-absent keeps any value', () => {
  const home = fixtureDir('hwc-ask-v1-userkey-');
  const pre = { mcp: {}, permission: { [ASK_RULE_ACTION]: 'deny' } };
  // Seed the config the installer merges into.
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify(pre, null, 2), 'utf8');
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  const config = loadOpencodeConfig(home);
  assert.equal(v1Permission(config)[ASK_RULE_ACTION], 'deny', 'the user’s value survives the write');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes('"deny" — the write tool is blocked entirely'), 'doctor names the user-owned denial');
});

// ── The saved-permission store (PR-1.5, demoted to a hygiene WARN) ────────
// The confirmation runs server-side now, so a saved client-side "always
// allow" row can no longer suppress it: the gate raises its own form inside
// the tool call and never routes through opencode's permission evaluation.
// Doctor keeps naming the row as a stale grant, WARN not FAIL, with the
// probe-measured removal commands. A clean home prints nothing at all.

const SAVED_WARN = '[WARN] ASK approval hygiene:';

function seedSavedRow(home: string, seed: Parameters<typeof seedStoreIn>[1]): string {
  return seedStoreIn(join(home, '.local', 'share'), seed);
}

test('doctor: a clean store prints no saved-row line (the section is invisible on zero rows)', () => {
  const home = fixtureDir('hwc-saved-clean-');
  installAskOn(home);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `the pair still passes, got:\n${stdout}`);
  assert.equal(stdout.includes(SAVED_WARN), false, 'no saved-row line on a clean home');
  assert.equal(stdout.includes('saved-permission store'), false, 'no store line either');
});

test('doctor: a saved "always allow" row WARNs with the store path, the row, and the two api commands', () => {
  const home = fixtureDir('hwc-saved-row-');
  installAskOn(home);
  const dbPath = seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'devkit-demo') }],
    permissions: [{ id: 'psv_demo_row', projectId: 'p-demo', action: ASK_RULE_ACTION }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(SAVED_WARN), `expected the hygiene warn, got:\n${stdout}`);
  assert.equal(stdout.includes('[FAIL] ASK approval hygiene'), false, 'the demotion: never a FAIL');
  assert.ok(stdout.includes('not fail-open'), 'the WARN states the gate already holds');
  assert.ok(stdout.includes(dbPath), 'the store path is named');
  assert.ok(stdout.includes('psv_demo_row'), 'the row id is listed');
  assert.ok(stdout.includes(join(home, 'work', 'devkit-demo')), 'the row project is listed');
  assert.ok(stdout.includes('opencode api GET /api/permission/saved'), 'the list command is taught');
  assert.ok(stdout.includes('opencode api DELETE /api/permission/saved/<id>'), 'the removal command is taught');
});

test('doctor: a saved row that does not cover the roster action prints nothing', () => {
  const home = fixtureDir('hwc-saved-foreign-');
  installAskOn(home);
  seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'other') }],
    permissions: [{ id: 'psv_other_tool', projectId: 'p-demo', action: 'some-other-server_some_tool' }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.equal(stdout.includes(SAVED_WARN), false, `a foreign row is not ours, got:\n${stdout}`);
});

test('doctor: a saved wildcard row covering the action WARNs too', () => {
  const home = fixtureDir('hwc-saved-wildcard-');
  installAskOn(home);
  seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'devkit-demo') }],
    permissions: [{ id: 'psv_wild', projectId: 'p-demo', action: 'huaweicloud-devkit_*' }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes(SAVED_WARN), `expected the wildcard row to warn, got:\n${stdout}`);
});

test('doctor: an unreadable store WARNs (warn-only, never a hard fail)', () => {
  const home = fixtureDir('hwc-saved-corrupt-');
  installAskOn(home);
  const opencodeDir = join(home, '.local', 'share', 'opencode');
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(join(opencodeDir, 'opencode.db'), 'not a database\n', 'utf8');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(
    stdout.includes(`${SAVED_WARN} opencode saved-permission store unreadable`),
    `expected the warn, got:\n${stdout}`,
  );
  assert.equal(stdout.includes('[FAIL] ASK approval hygiene'), false, 'an unreadable store is never a FAIL');
});

test('doctor: in token mode the stale row WARNs the same way (the row is inert in every posture)', () => {
  const home = fixtureDir('hwc-saved-token-');
  const config = installAskOn(home);
  delete config.permissions;
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'devkit-demo') }],
    permissions: [{ id: 'psv_token_mode', projectId: 'p-demo', action: ASK_RULE_ACTION }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'on' });
  assert.ok(stdout.includes('[PASS] ASK approval posture (token mode)'), `token mode still passes, got:\n${stdout}`);
  assert.ok(stdout.includes(SAVED_WARN), `the stale row is still named, got:\n${stdout}`);
});
