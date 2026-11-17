import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { allowRuleActions } from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';
import { fixtureDir } from './fixture-dir.ts';
import { runDoctor, runDoctorStatus, runInstall, runUninstall } from './doctor-helpers.ts';
import { seedStoreIn } from './opencode-saved-perms-harness.ts';

// The ASK approval posture through the real installer and doctor. Under the
// server-run gate the client half is one exact ALLOW rule per roster tool: it
// suppresses the redundant client popup, and the server's own confirmation is
// the only prompt — the elicitation form on opencode 2.x, the T3 chat
// round-trip (posture trust) on 1.19–1.x, where forms do not exist. The gate
// override HUAWEICLOUD_OPENCODE_ASK_RULE keeps the shape deterministic —
// never the natural probe, which would flip with the host's opencode.

const ACTION = allowRuleActions()[0]!;
const ASK_LABEL = 'ASK approval posture (client allow rules + server gate)';
const TOKEN_LABEL = 'ASK approval posture (token mode)';

// The opencode config the installer wrote, as a mutable record the
// hand-edit tests reshape in place.
function opencodeConfigPath(home: string): string {
  return join(home, '.config', 'opencode', 'opencode.json');
}

function loadOpencodeConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(opencodeConfigPath(home), 'utf8')) as Record<string, unknown>;
}

function saveOpencodeConfig(home: string, config: Record<string, unknown>): void {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(opencodeConfigPath(home), JSON.stringify(config, null, 2), 'utf8');
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

function v1Permission(config: Record<string, unknown>): Record<string, unknown> {
  return config.permission as Record<string, unknown>;
}

function ourAllow(): Record<string, unknown> {
  return { action: ACTION, resource: '*', effect: 'allow' };
}

function ourAllowFor(action: string): Record<string, unknown> {
  return { action, resource: '*', effect: 'allow' };
}

function ourAsk(): Record<string, unknown> {
  return { action: ACTION, resource: '*', effect: 'ask' };
}

function canonicalEntry(environment: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: ['node', '/bin/true'], environment };
}

// Seeds a config the installer merges into.
function seedConfig(home: string, config: Record<string, unknown>): void {
  saveOpencodeConfig(home, config);
}

// Installs with the ask gate forced on (the V2 shape), then returns the
// written config.
function installAskOn(home: string): Record<string, unknown> {
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  return loadOpencodeConfig(home);
}

// Installs with the V1 object shape forced.
function installAskV1(home: string): Record<string, unknown> {
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  return loadOpencodeConfig(home);
}

// ── The healthy pair and the migration (V2 array) ──

test('install writes the allow rule + server gate pair, and doctor PASSes', () => {
  const home = fixtureDir('hwc-ask-pair-');
  const config = installAskOn(home);
  assert.deepEqual(
    ruleEntries(config).filter((rule) => rule.action === ACTION),
    [ourAllow()],
    'the exact V2 allow rule is the client half',
  );
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the mcp env carries the server half');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `expected the pair to pass, got:\n${stdout}`);
});

test('a second install is idempotent: no duplicate rule, no false user-owned warning', () => {
  const home = fixtureDir('hwc-ask-repeat-');
  installAskOn(home);
  const stdout = runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  const config = loadOpencodeConfig(home);
  assert.deepEqual(
    ruleEntries(config).filter((rule) => rule.action === ACTION),
    [ourAllow()],
  );
  assert.equal(
    stdout.includes(`already has an entry for ${ACTION}`),
    false,
    `a rules-ours reinstall must not warn, got:\n${stdout}`,
  );
});

test('install migrates the old ask posture: the ask rule goes, the allow rule lands, the env is unchanged', () => {
  const home = fixtureDir('hwc-ask-migrate-');
  seedConfig(home, {
    permissions: [ourAsk()],
    mcp: { 'huaweicloud-devkit': canonicalEntry({ DEVKIT_APPROVAL_MODE: 'ask' }) },
  });
  const config = installAskOn(home);
  const rules = ruleEntries(config);
  assert.deepEqual(
    rules.filter((rule) => rule.action === ACTION),
    [ourAllow()],
    'ask replaced by allow',
  );
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the env is unchanged');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `the migrated pair passes, got:\n${stdout}`);
});

test('install on the old ask posture without the env establishes the server half', () => {
  const home = fixtureDir('hwc-ask-migrate-env-');
  seedConfig(home, {
    permissions: [ourAsk()],
    mcp: { 'huaweicloud-devkit': canonicalEntry() },
  });
  const config = installAskOn(home);
  assert.deepEqual(
    ruleEntries(config).filter((rule) => rule.action === ACTION),
    [ourAllow()],
  );
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask');
});

test('gate off writes no new rules and still migrates the old ask rules away', () => {
  const home = fixtureDir('hwc-ask-gateoff-migrate-');
  seedConfig(home, {
    permissions: [ourAsk()],
    mcp: { 'huaweicloud-devkit': canonicalEntry({ DEVKIT_APPROVAL_MODE: 'ask' }) },
  });
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  const config = loadOpencodeConfig(home);
  assert.equal('permissions' in config, false, 'the emptied array is pruned; no allow rule is written');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the existing server env is untouched');
});

test('install with the ask gate off writes neither half of the pair', () => {
  const home = fixtureDir('hwc-ask-off-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'off' });
  const config = loadOpencodeConfig(home);
  assert.ok(config.mcp, 'the mcp entry is still written');
  assert.equal('permissions' in config, false, 'no V2 permissions rules are written');
  assert.equal(v1Permission(config)?.[ACTION], undefined, 'no V1 allow key is written');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, undefined, 'no DEVKIT_APPROVAL_MODE env is written');
});

test('a user-set mode value wins: no client rules are kept, and stale ones are removed', () => {
  const home = fixtureDir('hwc-ask-usermode-');
  seedConfig(home, {
    mcp: { 'huaweicloud-devkit': canonicalEntry({ DEVKIT_APPROVAL_MODE: 'token' }) },
  });
  const stdout = runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  const config = loadOpencodeConfig(home);
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'token', 'the user’s value survives');
  assert.equal('permissions' in config, false, 'no client allow rules are kept');
  assert.ok(stdout.includes("keeping the user's value, so no client allow rules are kept"), 'the skip is warned');
  const doctorOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(doctorOut.includes(`[PASS] ${TOKEN_LABEL}`), `the user’s mechanical posture passes, got:\n${doctorOut}`);
});

test('a user-set mode value with stale allow rules: install removes them, keeps the value, doctor PASSes token mode', () => {
  const home = fixtureDir('hwc-ask-usermode-stale-');
  seedConfig(home, {
    permissions: [ourAllow()],
    permission: { [ACTION]: 'allow', 'user-server_user-tool': 'ask' },
    mcp: { 'huaweicloud-devkit': canonicalEntry({ DEVKIT_APPROVAL_MODE: 'token' }) },
  });
  const stdout = runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  const config = loadOpencodeConfig(home);
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'token', 'the user’s value still wins');
  assert.equal('permissions' in config, false, 'the stale V2 allow rows are removed');
  assert.equal(v1Permission(config)[ACTION], undefined, 'the stale V1 allow key is removed');
  assert.equal(v1Permission(config)['user-server_user-tool'], 'ask', 'unrelated user keys survive');
  assert.ok(
    stdout.includes("ASK client allow rules removed (DEVKIT_APPROVAL_MODE is the user's own)"),
    `the removal is logged, got:\n${stdout}`,
  );
  // One re-run converges: the mixed-state WARN is gone and token mode passes.
  const doctorOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(doctorOut.includes(`[PASS] ${TOKEN_LABEL}`), `token mode passes clean, got:\n${doctorOut}`);
  assert.equal(doctorOut.includes(`[WARN] ${ASK_LABEL}`), false, 'the mixed state never survives a re-run');
  assert.equal(doctorOut.includes(`[FAIL] ${ASK_LABEL}`), false);
});

test('a user-owned rule on another resource is skipped by name, never silently overridden (the roster replay)', () => {
  const home = fixtureDir('hwc-ask-userrule-');
  const userRule = { action: ACTION, resource: '/tmp/**', effect: 'allow' };
  seedConfig(home, { permissions: [userRule] });
  const stdout = runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  const config = loadOpencodeConfig(home);
  // The user's rule is untouched; the user-owned ACTION is the one skip, and
  // every OTHER roster action (PR-3a widened the roster to nine) gets its
  // own allow rule — skipping by name never suppresses the rest.
  assert.deepEqual(
    ruleEntries(config),
    [
      userRule,
      ...allowRuleActions()
        .filter((action) => action !== ACTION)
        .map((action) => ourAllowFor(action)),
    ],
    'the user rule is untouched and no "*" rule is added',
  );
  assert.ok(stdout.includes(`already has an entry for ${ACTION}`), 'the installer warns by action');
  const doctorOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(
    doctorOut.includes(`[WARN] ${ASK_LABEL}`),
    `the doctor surfaces the user-owned rule instead of passing or failing silently, got:\n${doctorOut}`,
  );
  assert.ok(doctorOut.includes(ACTION), 'the action is named');
  assert.ok(doctorOut.includes('user-owned'), 'the ownership is named');
  assert.equal(doctorOut.includes(`[FAIL] ${ASK_LABEL}`), false, 'an unhealable user-owned skip is never a FAIL');
});

// ── The doctor's fail and warn directions (V2 array) ──

test('doctor: a missing client rule with the server gate on FAILs (partial coverage)', () => {
  const home = fixtureDir('hwc-ask-missing-');
  const config = installAskOn(home);
  delete config.permissions;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the client allow rule is missing'), 'the missing half is named');
  assert.ok(stdout.includes(ACTION), 'the uncovered action is named');
  assert.ok(stdout.includes('npx huaweicloud-devkit install --target opencode'), 'the healable remediation is named');
});

test('doctor: a left-behind ask rule FAILs with the re-run remediation (the migration missed it)', () => {
  const home = fixtureDir('hwc-ask-residue-');
  const config = installAskOn(home);
  config.permissions = [ourAsk()];
  saveOpencodeConfig(home, config);
  const { stdout, status } = runDoctorStatus(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the ask residue to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the posture migration missed it'), 'the residue is named');
  assert.ok(stdout.includes('npx huaweicloud-devkit install --target opencode'), 'the re-run remediation is named');
  assert.equal(status, 1, 'a FAIL-shaped config exits nonzero (the doctor exit contract)');
});

test('doctor: a deny rule FAILs with the bricked-call direction', () => {
  const home = fixtureDir('hwc-ask-deny-');
  const config = installAskOn(home);
  config.permissions = [{ action: ACTION, resource: '*', effect: 'deny' }];
  saveOpencodeConfig(home, config);
  const { stdout, status } = runDoctorStatus(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the deny rule to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('"deny" — the write tool is blocked outright'), 'the danger is named');
  assert.ok(stdout.includes('delete that rule'), 'the removal is named');
  assert.equal(status, 1, 'a FAIL-shaped config exits nonzero (the doctor exit contract)');
});

test('doctor: allow rules without the server gate are a WARN naming the mixed state', () => {
  const home = fixtureDir('hwc-ask-nogate-');
  const config = installAskOn(home);
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the mixed state to warn, got:\n${stdout}`);
  assert.equal(stdout.includes(`[FAIL] ${ASK_LABEL}`), false, 'allow without the gate is never a fail');
  assert.ok(stdout.includes('DEVKIT_APPROVAL_MODE=ask is missing from the mcp entry'), 'the mixed state is named');
});

test('doctor: an unreadable permissions shape with the gate on WARNS, never a bare SKIP (replay B2)', () => {
  const home = fixtureDir('hwc-ask-unreadable-');
  const config = installAskOn(home);
  config.permissions = { action: ACTION, effect: 'allow' };
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the unverifiable half to warn, got:\n${stdout}`);
  assert.equal(
    stdout.includes('[SKIP] ASK approval posture'),
    false,
    'the doctor is never silent while the gate is on',
  );
  assert.ok(stdout.includes('permissions is not array-shaped'), 'the unreadable half is named');
  assert.ok(stdout.includes('the server gate still confirms every roster call'), 'the direction is named');
});

test('doctor: an unreadable config file with the gate on WARNS instead of going silent', () => {
  const home = fixtureDir('hwc-ask-corrupt-');
  installAskOn(home);
  writeFileSync(opencodeConfigPath(home), '{ not json', 'utf8');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the unreadable config to warn, got:\n${stdout}`);
  assert.ok(stdout.includes('config is unreadable'), 'the unreadable file is named');
});

test('doctor: rule absent and env absent is the legitimate token-mode PASS', () => {
  const home = fixtureDir('hwc-ask-token-');
  const config = installAskOn(home);
  delete config.permissions;
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[PASS] ${TOKEN_LABEL}`), `token mode must pass, got:\n${stdout}`);
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

// ── Uninstall ──

test('uninstall removes every roster rule in both shapes and keeps the user’s keys', () => {
  const home = fixtureDir('hwc-ask-uninstall-');
  const config = installAskOn(home);
  const userRule = { action: 'other-server_other_tool', resource: '*', effect: 'ask' };
  config.permissions = [...ruleEntries(config), userRule];
  config.permission = { [ACTION]: 'allow', custom: 'allow' };
  saveOpencodeConfig(home, config);

  runUninstall(home);
  const after = loadOpencodeConfig(home);
  assert.deepEqual(ruleEntries(after), [userRule], 'the roster rule is gone; the unrelated rule survives');
  assert.deepEqual(v1Permission(after), { custom: 'allow' }, 'the roster key is gone; the user key survives');
  assert.equal(after.mcp, undefined, 'the mcp entry (and its env) is gone wholesale');
});

// ── The V1 shape: the `permission` object form (opencode 1.19.0 – 1.x) ──

test('doctor: the v1 gate writes the allow key + env pair, and doctor PASSes', () => {
  const home = fixtureDir('hwc-ask-v1-pair-');
  const config = installAskV1(home);
  assert.equal(v1Permission(config)[ACTION], 'allow', 'the V1 permission key carries the client half');
  assert.equal('permissions' in config, false, 'the V2 array is not written on the v1 shape');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the mcp env carries the server half');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `expected the v1 pair to pass, got:\n${stdout}`);
});

test('install migrates a v1 ask key to allow, keeping the user’s sibling keys and the env', () => {
  const home = fixtureDir('hwc-ask-v1-migrate-');
  seedConfig(home, {
    permission: { '*': 'deny', [ACTION]: 'ask' },
    mcp: { 'huaweicloud-devkit': canonicalEntry({ DEVKIT_APPROVAL_MODE: 'ask' }) },
  });
  const config = installAskV1(home);
  assert.equal(v1Permission(config)[ACTION], 'allow', 'the key migrates to the allow value');
  assert.equal(v1Permission(config)['*'], 'deny', 'the user’s wildcard survives');
  assert.equal(envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE, 'ask', 'the env is unchanged');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `the migrated v1 pair passes, got:\n${stdout}`);
});

test('doctor: a v1 deny value FAILs with the bricked-call direction', () => {
  const home = fixtureDir('hwc-ask-v1-deny-');
  const config = installAskV1(home);
  v1Permission(config)[ACTION] = 'deny';
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the v1 deny to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('"deny" — the write tool is blocked outright'), 'the danger is named');
});

test('doctor: a v1 ask value FAILs (left-behind posture)', () => {
  const home = fixtureDir('hwc-ask-v1-ask-');
  const config = installAskV1(home);
  v1Permission(config)[ACTION] = 'ask';
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the v1 ask to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the posture migration missed it'), 'the residue is named');
});

test('doctor: the v1 key absent with the env set FAILs (partial coverage)', () => {
  const home = fixtureDir('hwc-ask-v1-missing-');
  const config = installAskV1(home);
  delete config.permission;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[FAIL] ${ASK_LABEL}`), `expected the missing key to fail, got:\n${stdout}`);
  assert.ok(stdout.includes('the client allow value is missing'), 'the missing half is named');
});

test('doctor: a v1 allow value without the env WARNS (the mixed state)', () => {
  const home = fixtureDir('hwc-ask-v1-nogate-');
  const config = installAskV1(home);
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the mixed state to warn, got:\n${stdout}`);
  assert.ok(stdout.includes('missing from the mcp entry'), 'the mixed state is named');
});

test('doctor: a scalar permission with the env set WARNS, never a bare SKIP', () => {
  const home = fixtureDir('hwc-ask-v1-unreadable-');
  const config = installAskV1(home);
  config.permission = 'allow';
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the scalar shape to warn, got:\n${stdout}`);
  assert.equal(stdout.includes('[SKIP] ASK approval posture'), false, 'never silent while the gate is on');
  assert.ok(stdout.includes('permission is not object-shaped'), 'the shape is named');
});

test('doctor: a v1 pattern-map value WARNS as unverifiable, not a misread posture', () => {
  const home = fixtureDir('hwc-ask-v1-foreign-');
  const config = installAskV1(home);
  v1Permission(config)[ACTION] = { '*': 'allow' };
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[WARN] ${ASK_LABEL}`), `expected the unverifiable value to warn, got:\n${stdout}`);
  assert.ok(stdout.includes('is not a readable effect'), 'the unverifiable value is named');
});

test('doctor: v1 key and env both absent is the legitimate token-mode PASS', () => {
  const home = fixtureDir('hwc-ask-v1-token-');
  const config = installAskV1(home);
  delete config.permission;
  delete envOf(mcpEntry(config)).DEVKIT_APPROVAL_MODE;
  saveOpencodeConfig(home, config);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes(`[PASS] ${TOKEN_LABEL}`), `token mode must pass, got:\n${stdout}`);
});

test('install honors a user-owned v1 deny key: add-only-if-absent keeps it, doctor FAILs it', () => {
  const home = fixtureDir('hwc-ask-v1-userkey-');
  seedConfig(home, { mcp: {}, permission: { [ACTION]: 'deny' } });
  runInstall(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  const config = loadOpencodeConfig(home);
  assert.equal(v1Permission(config)[ACTION], 'deny', 'the user’s value survives the write');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v1' });
  assert.ok(stdout.includes('"deny" — the write tool is blocked outright'), 'doctor names the user-owned denial');
});

// ── The saved-permission store (PR-1.5's hygiene WARN) ───────────────────
// The confirmation runs server-side, so a client-side "always allow" row can
// no longer suppress it. With the yield posture the client no longer prompts
// either, so no new row is ever created; an old row stays a stale grant worth
// cleaning up, named as a WARN, never a FAIL. A clean home prints nothing.

const SAVED_WARN = '[WARN] ASK approval hygiene:';

function seedSavedRow(home: string, seed: Parameters<typeof seedStoreIn>[1]): string {
  return seedStoreIn(join(home, '.local', 'share'), seed);
}

test('doctor: a clean store prints no saved-row line (the section is invisible on zero rows)', () => {
  const home = fixtureDir('hwc-saved-clean-');
  installAskOn(home);
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[PASS] ${ASK_LABEL}`), `the pair still passes, got:\n${stdout}`);
  assert.equal(stdout.includes(SAVED_WARN), false, 'no saved-row line on a clean home');
  assert.equal(stdout.includes('saved-permission store'), false, 'no store line either');
});

test('doctor: a saved "always allow" row WARNs with the store path, the row, and the two api commands', () => {
  const home = fixtureDir('hwc-saved-row-');
  installAskOn(home);
  const dbPath = seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'devkit-demo') }],
    permissions: [{ id: 'psv_demo_row', projectId: 'p-demo', action: ACTION }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
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
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.equal(stdout.includes(SAVED_WARN), false, `a foreign row is not ours, got:\n${stdout}`);
});

test('doctor: a saved wildcard row covering the action WARNs too', () => {
  const home = fixtureDir('hwc-saved-wildcard-');
  installAskOn(home);
  seedSavedRow(home, {
    projects: [{ id: 'p-demo', worktree: join(home, 'work', 'devkit-demo') }],
    permissions: [{ id: 'psv_wild', projectId: 'p-demo', action: 'huaweicloud-devkit_*' }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(SAVED_WARN), `expected the wildcard row to warn, got:\n${stdout}`);
});

test('doctor: an unreadable store WARNs (warn-only, never a hard fail)', () => {
  const home = fixtureDir('hwc-saved-corrupt-');
  installAskOn(home);
  const opencodeDir = join(home, '.local', 'share', 'opencode');
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(join(opencodeDir, 'opencode.db'), 'not a database\n', 'utf8');
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
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
    permissions: [{ id: 'psv_token_mode', projectId: 'p-demo', action: ACTION }],
  });
  const stdout = runDoctor(home, { HUAWEICLOUD_OPENCODE_ASK_RULE: 'v2' });
  assert.ok(stdout.includes(`[PASS] ${TOKEN_LABEL}`), `token mode still passes, got:\n${stdout}`);
  assert.ok(stdout.includes(SAVED_WARN), `the stale row is still named, got:\n${stdout}`);
});

test('doctor lists recorded session standing consents and stays silent on a clean home (PR-3a S3)', async () => {
  // The elicitation form's "remember for this session" tick writes a
  // scope:'session' consent row; the doctor lists those rows. A clean home
  // prints nothing — the committed byte-exact goldens already pin the
  // clean-home shape, so this half is the guard against a header leaking
  // onto every run. The seeding goes through the product's own
  // recordAskModeConsent (pinned to the fake home), then the REAL CLI
  // reads it back.
  const home = fixtureDir('hwc-ask-standing-');
  const cleanRun = runDoctor(home);
  assert.ok(!cleanRun.includes('Session standing consents'), 'a clean home lists nothing');

  const previousHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const { recordAskModeConsent } = await import('../plugins/huaweicloud-core/src/approval-ledger.ts');
    recordAskModeConsent({
      sessionId: 'stdin',
      tool: 'huaweicloud_sandbox_connect',
      argsHash: 'a'.repeat(64),
      outcome: 'granted',
      evidence: 'elicitation',
      evidenceFinal: true,
      scope: 'session',
    });
  } finally {
    if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previousHome;
  }
  const seededRun = runDoctor(home);
  assert.ok(seededRun.includes('Session standing consents'), 'the standing-consent header prints');
  assert.ok(seededRun.includes('huaweicloud_sandbox_connect'), 'the listed grant names its tool');
});
