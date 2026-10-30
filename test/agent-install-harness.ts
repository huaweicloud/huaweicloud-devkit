import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getCodexPluginName, getMarketplaceName } from '../plugins/huaweicloud-core/src/codex-probe.ts';
import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { skillTreeEquals } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const setupCli = join(root, 'bin', 'setup.cjs');
export const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export function makeEnv(home: string, extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
  };
  // Clear agent home overrides so installs land in the temp home, not the real one.
  // XDG_CONFIG_HOME redirects the opencode config root (xdgConfigHome);
  // CODEX_HOME keys the uninstaller's marketplace-cache cleanup (uninstallCodex);
  // CLAUDE_CONFIG_DIR redirects the option-3 generic MCP config (configureGenericMCP
  // resolves it first when writing .claude.json);
  // HUAWEICLOUD_DEVKIT_HOME redirects the telemetry face's global dir (and,
  // since port-v2defects, workbuddy's install/uninstall of it) — a developer
  // shell exporting it would silently run every install test under the
  // override (interrogate round 1; tests that need it pass it via extraEnv,
  // which wins over this clear).
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HUAWEICLOUD_HOME',
    'HUAWEICLOUD_DEVKIT_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete env[key];
  }
  // OfficeAce detection probes the real Windows registry / Program Files, which
  // would leak a real OfficeAce install into these fake-HOME tests (#654).
  env.HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT = '1';
  return { ...env, ...extra };
}

export function run(
  target: string,
  home: string,
  cwd: string,
  cmd: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  return spawnSync(process.execPath, [setupCli, cmd, '--target', target], {
    cwd,
    env: makeEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 240000,
  });
}

export function runAuto(home: string, cwd: string, cmd: string, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [setupCli, cmd], {
    cwd,
    env: makeEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 240000,
  });
}

export function fakeCodexEnv(
  cwd: string,
  options: {
    failPluginAdd?: boolean;
    failMarketplaceRemove?: boolean;
    conflictOnce?: boolean;
    listOutput?: string;
    listJson?: string;
  } = {},
) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(cwd, 'codex.log');
  const scriptPath = join(cwd, 'fake-codex.mjs');
  writeFileSync(
    scriptPath,
    `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
export const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('codex 0.0.0');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  if (args.includes('--json')) {
    console.log(process.env.FAKE_CODEX_LIST_JSON || '{"installed":[]}');
  } else {
    console.log(process.env.FAKE_CODEX_LIST_OUTPUT || '');
  }
  process.exit(0);
}
if (process.env.FAKE_CODEX_FAIL_PLUGIN_ADD === '1' && args[0] === 'plugin' && args[1] === 'add') {
  console.error('fake plugin add failed');
  process.exit(1);
}
if (
  process.env.FAKE_CODEX_CONFLICT_ONCE === '1' &&
  args[0] === 'plugin' &&
  args[1] === 'marketplace' &&
  args[2] === 'add'
) {
  // One-shot: the first marketplace add answers with the exact codex-cli
  // 0.162.1 different-source conflict (stderr, pinned wording — the
  // installer's detection regex couples to it); every later call passes.
  const fired = process.env.FAKE_CODEX_LOG + '.conflict-fired';
  if (!existsSync(fired)) {
    writeFileSync(fired, '1');
    console.error(
      "Error: marketplace 'huaweicloud-devkit' is already added from a different source; remove it before adding this source",
    );
    process.exit(1);
  }
}
if (
  process.env.FAKE_CODEX_FAIL_MARKETPLACE_REMOVE === '1' &&
  args[0] === 'plugin' &&
  args[1] === 'marketplace' &&
  args[2] === 'remove'
) {
  console.error('fake marketplace remove failed');
  process.exit(1);
}
process.exit(0);
`,
    'utf8',
  );
  const commandPath = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(commandPath, `#!/usr/bin/env sh\n"${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    chmodSync(commandPath, 0o755);
  }
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
    FAKE_CODEX_LOG: logPath,
    ...(options.failPluginAdd ? { FAKE_CODEX_FAIL_PLUGIN_ADD: '1' } : {}),
    ...(options.failMarketplaceRemove ? { FAKE_CODEX_FAIL_MARKETPLACE_REMOVE: '1' } : {}),
    ...(options.conflictOnce ? { FAKE_CODEX_CONFLICT_ONCE: '1' } : {}),
    ...(options.listOutput ? { FAKE_CODEX_LIST_OUTPUT: options.listOutput } : {}),
    ...(options.listJson ? { FAKE_CODEX_LIST_JSON: options.listJson } : {}),
    logPath,
  };
}

export function countSkills(dir: string) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

// Skills are server data for the full tree (MCP catalog; stdio list_skills
// additionally discloses skillRoot for direct reads); the six core
// meta-skills are ALSO disclosed natively (system-prompt visibility). The
// core roster is derived from the shipped manifest — the same parser the
// CLI reads.
export const parsedCoreRoster = parseCoreSkillNames(
  readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8'),
);
assert.ok(parsedCoreRoster, 'manifest core roster must parse');
export const coreRoster: Set<string> = parsedCoreRoster;

export function pluginSkills(pluginsDir: string) {
  return countSkills(join(pluginsDir, 'skills'));
}

// Native core disclosure contract for one agent: the native skill dir
// carries exactly the core-pack meta-skills (set membership, byte-equal to
// the payload the same run placed), a receipt records them, user skills
// survive, and no non-core owned name leaks in. The plugin dir still
// carries the full tree next to the server.
export function assertNativeCoreDisclosure(nativeSkillsDir: string, pluginsDir: string) {
  const owned = new Set(
    readdirSync(join(pluginsDir, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
  const entries = existsSync(nativeSkillsDir)
    ? readdirSync(nativeSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const present = new Set(entries);
  for (const name of coreRoster) {
    assert.ok(present.has(name), `core skill ${name} must be natively disclosed in ${nativeSkillsDir}`);
    assert.ok(
      skillTreeEquals(join(nativeSkillsDir, name), join(pluginsDir, 'skills', name)),
      `native copy of ${name} must equal the payload tree`,
    );
  }
  for (const name of entries) {
    if (owned.has(name)) {
      assert.ok(coreRoster.has(name), `non-core owned skill ${name} must not be native in ${nativeSkillsDir}`);
    }
  }
  const receiptPath = join(nativeSkillsDir, '.huaweicloud-devkit-native.json');
  assert.ok(existsSync(receiptPath), `native receipt must exist in ${nativeSkillsDir}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { names: string[]; layout?: string };
  assert.deepEqual(
    [...new Set(receipt.names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    'receipt records exactly the core roster',
  );
  assert.equal(receipt.layout, 'plugin-dir', 'the CLI sync records the plugin-dir layout');
  assert.ok(pluginSkills(pluginsDir) >= 6, 'plugin dir must carry the skills tree');
}

export function pluginVersion(pluginsDir: string) {
  const p = join(pluginsDir, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

export interface HermesAllowlist {
  approvals?: Array<{ event?: string; command?: string }>;
}

// The server payload every target ships through copyServerPayload: dist,
// safety, skills, and (since #758) the agent rules file.
export function assertServerPayload(pd: string): void {
  assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
  assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
  assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
  assert.ok(existsSync(join(pd, 'rules', 'huawei-agent-rules.mdc')));
}

// Native-dir reconciliation on install: pre-MCP residue (owned names
// without a receipt) is purged, a stale core copy is refreshed in place
// (remove-then-copy, so files a newer tree retired disappear), user skills
// survive, and residue on a non-installed agent's dir is cleaned too.

// A devkit-managed native dir (receipt present) keeps its core copies when a
// different agent is installed this run: deleting an installed agent's
// disclosure for a staleness window doctor already flags would be a silent
// capability loss.

// The native sync is disclosure, not payload: an unwritable native dir must
// warn and let the install complete (the MCP server remains the functional
// path), not fail the step.

// A torn receipt write must not demote a managed dir to residue treatment:
// the file's existence still proves devkit placement, so another agent's
// install keeps the core copies and warns instead of deleting them. The
// corrupt boundary is unified with the postinstall's: shape-broken names
// (parsable JSON, non-array) are corrupt too, not "healthy with no names".

// Receipt-remembered names carry delete rights only in a dir a sync row
// owns. In a foreign dir (officeace), a forged receipt must not be able to
// aim the cleanup at user content — including content in the devkit's own
// huaweicloud- namespace, which the shape filter alone would admit.

// A corrupt receipt at uninstall cannot yield remembered names; the
// possible retired-name leftovers are warned (and left in place — they may
// be user content), and the receipt file itself still goes.

// officeace's dir is never a sync target: owned names there are residue no
// matter what receipt a wholesale hand-copy carried in.

// Uninstall consumes the receipt before destroying it: a retired core name
// living only in the receipt must go with the install, not survive as
// permanently unidentifiable shadow-disclosure.

// The update dispatch drives the same native sync as install: a divergent
// copy and a deleted one must both converge back to the payload.

// Uninstall honors the receipt's maintainer attribution — dir-gated to the
// DSH native dir (the only writer of package-root receipts) and
// liveness-gated. A dead maintainer's copies are residue and go; a live
// one keeps them (the dedicated dsh-target test below). A package-root
// receipt in any other dir is hand-copied and earns nothing: normal
// removal, no attribution message.

// The DSH-target variant: the real uninstallDsh path with a marketplace
// receipt on ~/.dsh/skills (DSH_HOME faked) — live maintainer keeps the
// native dir, plugin-dir cleanup proceeds regardless, and aged crash
// residue is swept even on the attribution path.

// Crashed receipt writes leave pid-suffixed tmp files no other actor
// reclaims; uninstall sweeps the aged ones while a young (possibly
// in-flight concurrent writer's) tmp is left alone — the same age gate
// the writer applies, pinned here for the uninstall consumer.

// The plugin-dir skills tree is pruned on update: a retired skill name must
// not keep serving stale, ungated content through retrieve_skill.

// The pre-fix poisoning sibling's location in the fake home: makeEnv clears
// CODEX_HOME, so the installer's sweep resolves ~/.codex inside the temp home.
export function codexCacheStrayDir(home: string): string {
  return join(home, '.codex', 'plugins', 'cache', getMarketplaceName(), getCodexPluginName(), 'telemetry');
}

export function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The PTY-driven interactive tests below shell out through util-linux
// `script -qec` and /bin/bash — Linux-only flags and paths. The guard is
// "run only on Linux" (not "skip on Windows") so a future macOS matrix leg
// skips these instead of failing on BSD script's different flag set.
export const ptySkip = process.platform !== 'linux' ? 'PTY-driven tests require util-linux script' : false;

export function runAutoPty(
  home: string,
  cwd: string,
  cmd: string,
  input: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  seedProvisionedBinaries(home);
  return spawnSync('script', ['-qec', `${process.execPath} ${setupCli} ${cmd}`, '/dev/null'], {
    cwd,
    env: makeEnv(home, extraEnv),
    input,
    encoding: 'utf8',
    // PTY installs are install-bearing: installRuntimeDeps fetches undici
    // from a cold fake-HOME npm cache (the 79s bad-day measurement), and the
    // multi-select PTY tests install several targets — same 240s class as
    // run()/runAuto().
    timeout: 240000,
  });
}

export function runAutoPtyStaged(
  home: string,
  cwd: string,
  cmd: string,
  stages: Array<string | number>,
  extraEnv: Record<string, string | undefined> = {},
) {
  seedProvisionedBinaries(home);
  const env = makeEnv(home, extraEnv);
  const innerCmd = `${process.execPath} ${setupCli} ${cmd}`;
  const feed = stages.map((s) => (typeof s === 'number' ? `sleep ${s}` : `printf '%s\\n' "${s}"`)).join('; ');
  return spawnSync('/bin/bash', ['-c', `{ ${feed}; } | script -qec "${innerCmd}" /dev/null`], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240000,
  });
}

// Hermetic host binaries for PTY-driven installs. Under `script` the child
// sees a real TTY, so install-time provisioning takes its interactive path:
// without a present hcloud it downloads KooCLI for real and then blocks on
// the privacy-agreement prompt with the test's input already exhausted. The
// fakes make the provisioning loop resolve everything as present and skip —
// the seam still runs end to end, just without network or prompts.
export function seedProvisionedBinaries(home: string) {
  const binDir = join(home, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeHcloud = join(binDir, 'hcloud');
  writeFileSync(fakeHcloud, `#!/bin/sh\necho "Current KooCLI version: ${pkg.kooCliVersion}"\n`, 'utf8');
  chmodSync(fakeHcloud, 0o755);
  const fakeGateway = join(binDir, 'huaweicloud-open-mcp');
  writeFileSync(fakeGateway, '#!/bin/sh\n', 'utf8');
  chmodSync(fakeGateway, 0o755);
}
