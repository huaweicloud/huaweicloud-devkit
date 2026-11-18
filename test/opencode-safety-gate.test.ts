import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { opencodeSafetyGateVersionSupported } from '../plugins/huaweicloud-core/src/agents/opencode-config.ts';
import { fixtureDir } from './fixture-dir.ts';
import { doctorEnv, runDoctor, runInstall, runUninstall, setupCli } from './doctor-helpers.ts';

// The OpenCode >= 2.0 shell safety gate (integrations/opencode/hooks/
// safety-gate.js): the evaluate-hook adapter that denies shell commands the
// deployed dist/safety-policy.js classifier refuses. Part A pins the
// version floor, Part B drives the real adapter file against simulated
// evaluate events (the deployed layout staged in a fixtureDir, the policy
// module stubbed to the repo's real classifier, a throwing stub, or absent),
// Part C runs the real installer/doctor/uninstall with the deterministic
// HUAWEICLOUD_OPENCODE_SAFETY_GATE override (the permission-seam precedent).

const GATE_SRC = fileURLToPath(new URL('../integrations/opencode/hooks/safety-gate.js', import.meta.url));
const MJS_HOOK_SRC = fileURLToPath(
  new URL('../plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs', import.meta.url),
);
const REAL_POLICY_SRC = fileURLToPath(new URL('../plugins/huaweicloud-core/src/safety-policy.ts', import.meta.url));

interface GateModule {
  default: {
    id: string;
    setup(ctx: unknown): Promise<() => void>;
  };
}

type EvaluateEvent = { sessionID?: string; action: string; resources?: unknown[]; effect?: string; message?: string };

// Stage the deployed layout and import the adapter fresh: plugins/ holds the
// gate (renamed .mjs like the skill-tracker load-smoke — a fixtureDir has no
// package.json, and .js would parse as CommonJS), huaweicloud-plugins/ holds
// the payload root with the type:module package.json the real deploy ships
// (installRuntimeDeps) so dist/safety-policy.js parses as ESM.
async function loadGate(
  policy: 'real' | 'throwing' | 'missing',
  prefix: string,
): Promise<(event: EvaluateEvent) => Promise<void>> {
  const dir = fixtureDir(`safety-gate-${prefix}-`);
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  copyFileSync(GATE_SRC, join(dir, 'plugins', 'safety-gate.mjs'));
  if (policy !== 'missing') {
    const distDir = join(dir, 'huaweicloud-plugins', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(dir, 'huaweicloud-plugins', 'package.json'),
      `${JSON.stringify({ name: 'huaweicloud-devkit', type: 'module' }, null, 2)}\n`,
    );
    writeFileSync(
      join(distDir, 'safety-policy.js'),
      policy === 'real'
        ? `export { classifyTextCommand } from ${JSON.stringify(pathToFileURL(REAL_POLICY_SRC).href)};\n`
        : "export function classifyTextCommand() {\n  throw new Error('injected classifier failure');\n}\n",
    );
  }
  const mod = (await import(pathToFileURL(join(dir, 'plugins', 'safety-gate.mjs')).href)) as GateModule;
  assert.equal(mod.default.id, 'huaweicloud-safety-gate');
  let registered: ((event: EvaluateEvent) => Promise<void>) | undefined;
  const ctx = {
    permission: {
      hook: async (name: string, fn: (event: EvaluateEvent) => Promise<void>) => {
        assert.equal(name, 'evaluate');
        registered = fn;
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  assert.equal(typeof cleanup, 'function', 'a V2 host may invoke the setup return value unguarded');
  assert.doesNotThrow(() => cleanup());
  assert.ok(registered, 'the handler was registered via ctx.permission.hook');
  return registered;
}

function shellEvent(command: string | unknown[]): EvaluateEvent {
  // The measured V2 shape: resources[0] carries the full command string; an
  // array input tests the multi-element join directly.
  const resources = Array.isArray(command) ? command : [command];
  return { sessionID: 'ses_test', action: 'shell', resources, effect: 'allow' };
}

const DENY_PREFIX = 'Huawei Cloud safety hook blocked this action: ';

// ── Part A: the version floor ──

test('opencodeSafetyGateVersionSupported pins the 2.0 floor and the skip polarity', () => {
  assert.equal(opencodeSafetyGateVersionSupported('2.0.0'), true, 'the floor itself');
  assert.equal(opencodeSafetyGateVersionSupported('v2.2.7'), true, 'the measured host');
  assert.equal(opencodeSafetyGateVersionSupported('1.19.9'), false, '1.x has no evaluate hook (V1 named it bash)');
  assert.equal(opencodeSafetyGateVersionSupported('1.19'), false, 'unparsable per the anchored shape');
  assert.equal(
    opencodeSafetyGateVersionSupported('opencode 2.2.7'),
    false,
    'the probe must extract, not pass raw output',
  );
  assert.equal(opencodeSafetyGateVersionSupported(null), false, 'absent/unparsable polarity is skip');
});

// ── Part B: the handler against simulated evaluate events ──

test('a benign read and a benign shell command leave the effect untouched', async () => {
  const gate = await loadGate('real', 'benign');
  const ls = shellEvent('ls /tmp');
  await gate(ls);
  assert.equal(ls.effect, 'allow');
  assert.equal(ls.message, undefined);
  const echo = shellEvent('echo gate-smoke-ok');
  await gate(echo);
  assert.equal(echo.effect, 'allow');
  const read = shellEvent('hcloud ECS ListServersDetails --cli-region=cn-north-4');
  await gate(read);
  assert.equal(read.effect, 'allow', 'a plain hcloud read is not the write class');
});

test('an unapproved hcloud write denies with the plan-and-approval remediation', async () => {
  const gate = await loadGate('real', 'write');
  const event = shellEvent('hcloud ECS DeleteServers --server.id=x');
  await gate(event);
  assert.equal(event.effect, 'deny');
  assert.match(event.message ?? '', new RegExp(`^${DENY_PREFIX}`));
  assert.match(event.message ?? '', /plan and receives explicit user approval/);
});

test('credential-file reads, env dumps, and recursive forced rm each deny', async () => {
  const gate = await loadGate('real', 'families');
  const cred = shellEvent('cat ~/.hcloud/config');
  await gate(cred);
  assert.equal(cred.effect, 'deny');
  assert.match(cred.message ?? '', /credential or profile files/);
  const dump = shellEvent('env | grep HUAWEICLOUD');
  await gate(dump);
  assert.equal(dump.effect, 'deny');
  assert.match(dump.message ?? '', /Dumping cloud credential environment variables/);
  const rm = shellEvent('rm -rf /');
  await gate(rm);
  assert.equal(rm.effect, 'deny');
  assert.match(rm.message ?? '', new RegExp(`^${DENY_PREFIX}`));
});

test('multi-element resources join into one command text; odd entries never break the join', async () => {
  const gate = await loadGate('real', 'join');
  const split = shellEvent(['hcloud ECS DeleteServers', '--server.id=x']);
  await gate(split);
  assert.equal(split.effect, 'deny', 'the join reconstructs the write command');
  // filter(String) drops only the empty string; null survives the filter but
  // joins as nothing, so a stray entry never garbles the command text.
  const withNull = shellEvent([null, '', 'hcloud ECS DeleteServers --server.id=x']);
  await gate(withNull);
  assert.equal(withNull.effect, 'deny');
});

test('non-shell actions are zero-intervention, including devkit MCP tool actions', async () => {
  const gate = await loadGate('real', 'nonshell');
  for (const action of [
    'huaweicloud-devkit_huaweicloud_run_approved_command',
    'huaweicloud-devkit_huaweicloud_run_readonly_command',
    'edit',
    'write',
    'bash', // the V1 action name never fires on a V2 host; if it did, the adapter must not treat it as the shell face
  ]) {
    const event: EvaluateEvent = {
      sessionID: 'ses_test',
      action,
      resources: ['hcloud ECS DeleteServers --server.id=x'],
      effect: 'allow',
    };
    await gate(event);
    assert.equal(event.effect, 'allow', `${action} must stay zero-intervention`);
    assert.equal(event.message, undefined, `${action} must not carry a deny message`);
  }
});

test('empty resources are zero-intervention', async () => {
  const gate = await loadGate('real', 'empty');
  for (const resources of [[], [''], [null]]) {
    const event = shellEvent(resources);
    await gate(event);
    assert.equal(event.effect, 'allow');
    assert.equal(event.message, undefined);
  }
});

test('an over-cap payload denies fail-closed through the classifier cap (256 KiB)', async () => {
  const gate = await loadGate('real', 'cap');
  const event = shellEvent(`hcloud ECS DeleteServers --server.id=x ${'A'.repeat(300_000)}`);
  await gate(event);
  assert.equal(event.effect, 'deny');
  assert.match(event.message ?? '', /too large to classify safely/);
});

test('a throwing classifier denies with the classify-failure reason (G1-M2 posture)', async () => {
  const gate = await loadGate('throwing', 'inject');
  const event = shellEvent('hcloud ECS DeleteServers --server.id=x');
  await gate(event);
  assert.equal(event.effect, 'deny');
  assert.match(event.message ?? '', /the safety classifier failed to run/);
  assert.match(event.message ?? '', /Reinstall the huaweicloud-devkit plugin/);
});

test('a missing policy module denies with the load-failure reason naming the reinstall', async () => {
  const gate = await loadGate('missing', 'nopol');
  const event = shellEvent('hcloud ECS DeleteServers --server.id=x');
  await gate(event);
  assert.equal(event.effect, 'deny');
  assert.match(event.message ?? '', /the safety policy failed to load/);
  assert.match(event.message ?? '', /Reinstall the huaweicloud-devkit plugin/);
});

test('the deny prefix stays byte-identical to the PreToolUse hook wrapper', () => {
  const literal = (source: string, name: string): string => {
    // The reason literals are wrapped across two lines in both files; \s+
    // closes over the newline.
    const m = new RegExp(`const ${name} =\\s+'([^']+)'`).exec(source);
    assert.ok(m, `the ${name} literal must be extractable`);
    return m[1]!;
  };
  const gate = readFileSync(GATE_SRC, 'utf8');
  const mjs = readFileSync(MJS_HOOK_SRC, 'utf8');
  assert.equal(literal(gate, 'DENY_PREFIX'), literal(mjs, 'DENY_PREFIX'));
  assert.equal(literal(gate, 'POLICY_LOAD_FAILED_REASON'), literal(mjs, 'POLICY_LOAD_FAILED_REASON'));
  assert.equal(literal(gate, 'CLASSIFY_FAILED_REASON'), literal(mjs, 'CLASSIFY_FAILED_REASON'));
});

// ── Part C: the installer, status, doctor, and uninstall with the override ──

const gateFileIn = (home: string): string => join(home, '.config', 'opencode', 'plugins', 'safety-gate.js');

test('install deploys the adapter beside the payload it imports; off skips and heals drift', () => {
  const home = fixtureDir('safety-gate-install-on-');
  const out = runInstall(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  assert.match(out, /Safety gate -> /);
  assert.ok(existsSync(gateFileIn(home)), 'the adapter file lands in the plugins dir');
  assert.ok(
    existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'safety-policy.js')),
    'the payload module the adapter imports must be deployed with it',
  );

  const homeOff = fixtureDir('safety-gate-install-off-');
  const offOut = runInstall(homeOff, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'off' });
  assert.match(offOut, /skipping the shell safety-gate plugin/);
  assert.ok(!existsSync(gateFileIn(homeOff)));

  // Drift heal: an install made while the gate was on must not keep the file
  // after the host downgraded (the off re-run removes it).
  const homeHeal = fixtureDir('safety-gate-heal-');
  runInstall(homeHeal, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  assert.ok(existsSync(gateFileIn(homeHeal)));
  const healOut = runInstall(homeHeal, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'off' });
  assert.ok(!existsSync(gateFileIn(homeHeal)), 'the off install heals the leftover file');
  assert.match(healOut, /skipping the shell safety-gate plugin/);
});

test('status reports the gate, uninstall removes it item-by-item', () => {
  const home = fixtureDir('safety-gate-status-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  const status = spawnSync(process.execPath, [setupCli, 'status', '--target', 'opencode'], {
    encoding: 'utf8',
    env: doctorEnv(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' }),
    timeout: 60_000,
  });
  assert.equal(status.status, 0, status.stderr);
  const statusText = (status.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  assert.match(statusText, /Shell safety gate: Installed/);

  const uninstallOut = runUninstall(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  assert.match(uninstallOut, /Removed safety-gate plugin/);
  assert.ok(!existsSync(gateFileIn(home)));
});

test('doctor: PASS when deployed, FAIL when the gate is on but the file is missing, SKIP below the floor', () => {
  const home = fixtureDir('safety-gate-doctor-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  const pass = runDoctor(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  assert.match(pass, /\[PASS\] Shell safety gate \(evaluate-hook adapter\)/);

  // The file never written (install ran below the floor) while doctor's gate
  // is forced on: the verifiably-eligible host is missing its adapter.
  const homeMissing = fixtureDir('safety-gate-doctor-missing-');
  runInstall(homeMissing, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'off' });
  const fail = runDoctor(homeMissing, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'on' });
  assert.match(fail, /\[FAIL\] Shell safety gate \(evaluate-hook adapter\)/);
  assert.match(fail, /Run: npx huaweicloud-devkit install --target opencode/);

  const skip = runDoctor(home, { HUAWEICLOUD_OPENCODE_SAFETY_GATE: 'off' });
  assert.match(skip, /\[SKIP\] Shell safety gate \(opencode not verifiably at or above 2\.0\.0\)/);
});
