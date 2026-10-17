import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getMarketplaceName } from '../plugins/huaweicloud-core/src/codex-probe.ts';
import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { skillTreeEquals } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home: string, extra: Record<string, string | undefined> = {}) {
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
  // resolves it first when writing .claude.json).
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HUAWEICLOUD_HOME',
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

function run(
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

function runAuto(home: string, cwd: string, cmd: string, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [setupCli, cmd], {
    cwd,
    env: makeEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function fakeCodexEnv(
  cwd: string,
  options: { failPluginAdd?: boolean; failMarketplaceRemove?: boolean; listOutput?: string; listJson?: string } = {},
) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(cwd, 'codex.log');
  const scriptPath = join(cwd, 'fake-codex.mjs');
  writeFileSync(
    scriptPath,
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
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
    ...(options.listOutput ? { FAKE_CODEX_LIST_OUTPUT: options.listOutput } : {}),
    ...(options.listJson ? { FAKE_CODEX_LIST_JSON: options.listJson } : {}),
    logPath,
  };
}

function countSkills(dir: string) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

// Skills are server data for the full tree (MCP catalog; stdio list_skills
// additionally discloses skillRoot for direct reads); the six core
// meta-skills are ALSO disclosed natively (system-prompt visibility). The
// core roster is derived from the shipped manifest — the same parser the
// CLI reads.
const parsedCoreRoster = parseCoreSkillNames(
  readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8'),
);
assert.ok(parsedCoreRoster, 'manifest core roster must parse');
const coreRoster: Set<string> = parsedCoreRoster;

function pluginSkills(pluginsDir: string) {
  return countSkills(join(pluginsDir, 'skills'));
}

// Native core disclosure contract for one agent: the native skill dir
// carries exactly the core-pack meta-skills (set membership, byte-equal to
// the payload the same run placed), a receipt records them, user skills
// survive, and no non-core owned name leaks in. The plugin dir still
// carries the full tree next to the server.
function assertNativeCoreDisclosure(nativeSkillsDir: string, pluginsDir: string) {
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

function pluginVersion(pluginsDir: string) {
  const p = join(pluginsDir, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

interface HermesAllowlist {
  approvals?: Array<{ event?: string; command?: string }>;
}

test('opencode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
    assertNativeCoreDisclosure(join(home, '.config', 'opencode', 'skills'), pd);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.config', 'opencode', 'skills')), 0);
    assert.ok(
      !existsSync(join(home, '.config', 'opencode', 'skills', '.huaweicloud-devkit-native.json')),
      'native receipt removed on uninstall',
    );
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assertNativeCoreDisclosure(
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Native-dir reconciliation on install: pre-MCP residue (owned names
// without a receipt) is purged, a stale core copy is refreshed in place
// (remove-then-copy, so files a newer tree retired disappear), user skills
// survive, and residue on a non-installed agent's dir is cleaned too.
test('install reconciles native skill dirs: residue purged, core refreshed, user skills preserved', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    mkdirSync(join(nativeDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(nativeDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\nstale\n');
    mkdirSync(join(nativeDir, 'huaweicloud-core', 'references'), { recursive: true });
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), '---\nname: huaweicloud-core\n---\nstale\n');
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'references', 'retired-by-newer-tree.md'), 'orphan\n');
    mkdirSync(join(nativeDir, 'huawei-my-own-runbook'), { recursive: true });
    writeFileSync(
      join(nativeDir, 'huawei-my-own-runbook', 'SKILL.md'),
      '---\nname: huawei-my-own-runbook\n---\nuser\n',
    );
    // Residue on an agent this run does not install: owned names there are
    // stale regardless (no receipt, no replacement coming this run).
    const otherDir = join(home, '.workbuddy', 'skills');
    mkdirSync(join(otherDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(otherDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\nstale\n');

    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!existsSync(join(nativeDir, 'huawei-ecs')), 'non-core owned copy must be purged');
    assert.ok(existsSync(join(nativeDir, 'huawei-my-own-runbook')), 'user skill sharing the prefix must survive');
    assert.ok(!existsSync(join(otherDir, 'huawei-ecs')), 'residue on a non-installed agent must be purged');
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assert.ok(
      skillTreeEquals(join(nativeDir, 'huaweicloud-core'), join(pd, 'skills', 'huaweicloud-core')),
      'stale core copy must be refreshed byte-equal to the payload',
    );
    assert.ok(
      !existsSync(join(nativeDir, 'huaweicloud-core', 'references', 'retired-by-newer-tree.md')),
      'a file the newer tree retired must not survive the refresh',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A devkit-managed native dir (receipt present) keeps its core copies when a
// different agent is installed this run: deleting an installed agent's
// disclosure for a staleness window doctor already flags would be a silent
// capability loss.
test('install for one target keeps another managed agent core copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    assert.ok(existsSync(join(workbuddyNative, '.huaweicloud-devkit-native.json')));
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-core')),
      'managed core copies of a non-installed-this-run agent must survive',
    );
    assertNativeCoreDisclosure(
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The native sync is disclosure, not payload: an unwritable native dir must
// warn and let the install complete (the MCP server remains the functional
// path), not fail the step.
test('install warns and continues when the native skill dir cannot be created', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(nativeDir, 'occupied by a file');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /native core skills not synced/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A torn receipt write must not demote a managed dir to residue treatment:
// the file's existence still proves devkit placement, so another agent's
// install keeps the core copies and warns instead of deleting them. The
// corrupt boundary is unified with the postinstall's: shape-broken names
// (parsable JSON, non-array) are corrupt too, not "healthy with no names".
test('corrupt receipt keeps managed core copies and warns', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": [torn');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /unreadable native receipt .*\.workbuddy.*rewrites it/);
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-core')),
      'a torn receipt must not cost a managed agent its core copies',
    );

    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": null}');
    const shapeBroken = run('opencode', home, cwd, 'install');
    assert.equal(shapeBroken.status, 0, shapeBroken.stderr);
    assert.match(
      shapeBroken.stdout,
      /unreadable native receipt .*\.workbuddy/,
      'a shape-broken receipt is corrupt, not ok-empty',
    );
    assert.ok(existsSync(join(workbuddyNative, 'huaweicloud-core')), 'core copies kept');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Receipt-remembered names carry delete rights only in a dir a sync row
// owns. In a foreign dir (officeace), a forged receipt must not be able to
// aim the cleanup at user content — including content in the devkit's own
// huaweicloud- namespace, which the shape filter alone would admit.
test('forged receipt cannot delete user content in the officeace dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const officeaceDir = join(home, '.office-claw', 'skills');
    mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
    mkdirSync(join(officeaceDir, 'huaweicloud-user-notes'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huaweicloud-user-notes', 'SKILL.md'), '---\nname: x\n---\nuser\n', 'utf8');
    writeFileSync(
      join(officeaceDir, '.huaweicloud-devkit-native.json'),
      JSON.stringify({ names: ['huawei-ecs', 'huaweicloud-user-notes'] }),
    );
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!existsSync(join(officeaceDir, 'huawei-ecs')), 'owned residue in a foreign dir still goes');
    assert.ok(
      existsSync(join(officeaceDir, 'huaweicloud-user-notes')),
      'receipt-remembered names must not earn delete rights in a foreign dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A corrupt receipt at uninstall cannot yield remembered names; the
// possible retired-name leftovers are warned (and left in place — they may
// be user content), and the receipt file itself still goes.
test('uninstall warns about possible leftovers when the receipt is corrupt', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    mkdirSync(join(workbuddyNative, 'huaweicloud-retired-x'), { recursive: true });
    writeFileSync(join(workbuddyNative, 'huaweicloud-retired-x', 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": [torn');
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.match(
      res.stdout,
      /unreadable native receipt .*possible devkit leftover\(s\) left in place: huaweicloud-retired-x/,
    );
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-retired-x')),
      'an unidentifiable name is never auto-deleted',
    );
    assert.ok(
      !existsSync(join(workbuddyNative, '.huaweicloud-devkit-native.json')),
      'the corrupt receipt is still removed',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// officeace's dir is never a sync target: owned names there are residue no
// matter what receipt a wholesale hand-copy carried in.
test('forged receipt cannot exempt owned names in the officeace dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const officeaceDir = join(home, '.office-claw', 'skills');
    mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
    writeFileSync(join(officeaceDir, '.huaweicloud-devkit-native.json'), '{"names":["huawei-ecs"]}');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      !existsSync(join(officeaceDir, 'huawei-ecs')),
      'officeace stays without native skill copies, receipt or not',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Uninstall consumes the receipt before destroying it: a retired core name
// living only in the receipt must go with the install, not survive as
// permanently unidentifiable shadow-disclosure.
test('uninstall removes receipt-remembered retired names', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    const receiptPath = join(nativeDir, '.huaweicloud-devkit-native.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { names: string[] };
    mkdirSync(join(nativeDir, 'huaweicloud-retired-example'), { recursive: true });
    writeFileSync(join(nativeDir, 'huaweicloud-retired-example', 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
    writeFileSync(receiptPath, JSON.stringify({ names: [...receipt.names, 'huaweicloud-retired-example'] }));
    const res = run('opencode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.ok(!existsSync(join(nativeDir, 'huaweicloud-retired-example')), 'retired name must not survive uninstall');
    assert.ok(!existsSync(receiptPath), 'receipt removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The update dispatch drives the same native sync as install: a divergent
// copy and a deleted one must both converge back to the payload.
test('update restores divergent and missing native core copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), 'stale\n', 'utf8');
    rmSync(join(nativeDir, 'huaweicloud-safety'), { recursive: true, force: true });
    const res = run('opencode', home, cwd, 'update');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Update complete/);
    assertNativeCoreDisclosure(nativeDir, join(home, '.config', 'opencode', 'huaweicloud-plugins'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Uninstall honors the receipt's maintainer attribution — dir-gated to the
// DSH native dir (the only writer of package-root receipts) and
// liveness-gated. A dead maintainer's copies are residue and go; a live
// one keeps them (the dedicated dsh-target test below). A package-root
// receipt in any other dir is hand-copied and earns nothing: normal
// removal, no attribution message.
test('uninstall removes dead-maintainer copies and ignores foreign-dir package-root receipts', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    // Dead maintainer on the real dsh dir: the recorded package root is
    // gone — residue, not disclosure.
    const dshHome = join(home, '.dsh');
    const dshNative = join(dshHome, 'skills');
    const deadRoot = join(home, 'gone-profile-pkg');
    for (const name of coreRoster) {
      mkdirSync(join(dshNative, name), { recursive: true });
      writeFileSync(join(dshNative, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(dshNative, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: deadRoot,
      }),
    );
    const dsh = run('dsh', home, cwd, 'uninstall');
    assert.match(dsh.stdout, /Uninstall complete/);
    assert.match(dsh.stdout, /recorded package maintainer is gone — removing them/);
    assert.ok(!existsSync(join(dshNative, 'huaweicloud-core')), 'dead-maintainer copies must go');

    // A LIVE package-root receipt on a foreign (workbuddy) dir: hand-copied
    // by construction — the postinstall only writes the dsh dir — so it
    // earns no attribution there.
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const wbNative = join(home, '.workbuddy', 'skills');
    const liveRoot = join(home, 'staged-profile-pkg');
    const liveSkills = join(liveRoot, 'plugins', 'huaweicloud-core', 'skills');
    for (const name of coreRoster) {
      mkdirSync(join(liveSkills, name), { recursive: true });
      writeFileSync(join(liveSkills, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(wbNative, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: liveRoot,
      }),
    );
    const foreign = run('workbuddy', home, cwd, 'uninstall');
    assert.match(foreign.stdout, /Uninstall complete/);
    assert.ok(
      !foreign.stdout.includes('belong to the DSH profile'),
      'a foreign-dir package-root receipt earns no attribution',
    );
    assert.ok(!existsSync(join(wbNative, 'huaweicloud-core')), 'the copies go with the normal removal');
    assert.ok(!existsSync(join(wbNative, '.huaweicloud-devkit-native.json')), 'the receipt goes too');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The DSH-target variant: the real uninstallDsh path with a marketplace
// receipt on ~/.dsh/skills (DSH_HOME faked) — live maintainer keeps the
// native dir, plugin-dir cleanup proceeds regardless, and aged crash
// residue is swept even on the attribution path.
test('uninstall --target dsh honors a live marketplace receipt', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const nativeDir = join(dshHome, 'skills');
    const liveRoot = join(home, 'staged-profile-pkg');
    const liveSkills = join(liveRoot, 'plugins', 'huaweicloud-core', 'skills');
    for (const name of coreRoster) {
      mkdirSync(join(nativeDir, name), { recursive: true });
      writeFileSync(join(nativeDir, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
      mkdirSync(join(liveSkills, name), { recursive: true });
      writeFileSync(join(liveSkills, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(nativeDir, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: liveRoot,
      }),
    );
    const agedTmp = join(nativeDir, '.huaweicloud-devkit-native.json.424242.tmp');
    writeFileSync(agedTmp, 'torn');
    const stale = new Date(Date.now() - 120_000);
    utimesSync(agedTmp, stale, stale);
    const res = run('dsh', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.match(res.stdout, /belong to the DSH profile's huaweicloud-devkit package/);
    assert.ok(existsSync(join(nativeDir, 'huaweicloud-core')), 'the marketplace dir is left for its maintainer');
    assert.ok(existsSync(join(nativeDir, '.huaweicloud-devkit-native.json')), 'the receipt stays with the copies');
    assert.ok(!existsSync(agedTmp), 'aged crash residue is swept even on the attribution path');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Crashed receipt writes leave pid-suffixed tmp files no other actor
// reclaims; uninstall sweeps the aged ones while a young (possibly
// in-flight concurrent writer's) tmp is left alone — the same age gate
// the writer applies, pinned here for the uninstall consumer.
test('uninstall sweeps aged receipt tmp files and leaves young ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.workbuddy', 'skills');
    const agedTmp = join(nativeDir, '.huaweicloud-devkit-native.json.424242.tmp');
    const youngTmp = join(nativeDir, '.huaweicloud-devkit-native.json.999999.tmp');
    writeFileSync(agedTmp, 'torn');
    writeFileSync(youngTmp, 'in-flight');
    const stale = new Date(Date.now() - 120_000);
    utimesSync(agedTmp, stale, stale);
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.ok(!existsSync(agedTmp), 'the aged tmp file is swept');
    assert.ok(existsSync(youngTmp), 'a young tmp is never swept by the uninstall path');
    assert.deepEqual(
      readdirSync(nativeDir).filter((n) => n !== '.huaweicloud-devkit-native.json.999999.tmp'),
      [],
      'nothing else devkit-owned remains in the dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('workbuddy', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[WorkBuddy\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.workbuddy', 'huaweicloud-plugins');
    assertNativeCoreDisclosure(join(home, '.workbuddy', 'skills'), pd);
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.workbuddy', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy uninstall cleans a PostToolUse-only settings.json without crashing (#556)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.workbuddy', 'skills'), { recursive: true });
    mkdirSync(join(home, '.workbuddy', 'huaweicloud-plugins'), { recursive: true });
    // Typical post-install state: settings.json hooks contains only PostToolUse.
    writeFileSync(
      join(home, '.workbuddy', 'settings.json'),
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'python x', timeout: 3 }] }] },
      }),
    );
    // Bug-02: deleting settings.hooks then reading settings.hooks.PostToolUse
    // crashed the process; uninstall must complete and clean the hook.
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Uninstall complete/);
    const settings = JSON.parse(readFileSync(join(home, '.workbuddy', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks, undefined, 'PostToolUse-only hooks must be removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assertNativeCoreDisclosure(join(home, '.workbuddy', 'skills'), join(home, '.workbuddy', 'huaweicloud-plugins'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('codex-desktop', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Codex Desktop\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')) >= 6);
    const pd = join(home, 'plugins', 'huaweicloud-devkit');
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
    // The status section this target lacked for months: both surfaces it
    // owns (plugin dir payload + marketplace registration) must report in.
    const status = run('codex-desktop', home, cwd, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /\[Codex Desktop\]/);
    assert.match(status.stdout, /MCP Server:.*Installed/);
    assert.match(status.stdout, /Marketplace:.*Registered/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
    const res = run('codex-desktop', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')), 0);
    assert.ok(!existsSync(join(home, 'plugins', 'huaweicloud-devkit')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help lists supported agent targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = spawnSync(process.execPath, [setupCli, 'help'], {
      cwd,
      env: makeEnv(home),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.match(res.stdout, /install --target workbuddy/);
    assert.match(res.stdout, /install --target dsh/);
    assert.match(res.stdout, /install --target codearts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw install creates skills, MCP server, and safety policy in .agents', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('openclaw', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenClaw\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.agents', 'huaweicloud-plugins');
    assertNativeCoreDisclosure(join(home, '.agents', 'skills'), pd);
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('openclaw', home, cwd, 'install').status, 0);
    const res = run('openclaw', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.agents', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.agents', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('hermes', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Hermes Agent\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.hermes', 'huaweicloud-plugins');
    assertNativeCoreDisclosure(join(home, '.hermes', 'skills'), pd);
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    assert.ok(existsSync(allowlistPath), 'shell hook allowlist must be written on install');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as HermesAllowlist;
    const entry = (allowlist.approvals || []).find(
      (a) =>
        a &&
        a.event === 'pre_tool_call' &&
        typeof a.command === 'string' &&
        a.command.includes('huaweicloud-safety.py'),
    );
    assert.ok(entry, 'allowlist must pre-authorize the pre_tool_call safety hook');
    const pluginDir = join(home, '.hermes', 'plugins', 'huaweicloud-safety');
    assert.ok(existsSync(join(pluginDir, 'plugin.yaml')), 'hook plugin manifest must be installed');
    assert.ok(existsSync(join(pluginDir, '__init__.py')), 'hook plugin module must be installed');
    const init = readFileSync(join(pluginDir, '__init__.py'), 'utf8');
    assert.match(init, /def register\(ctx\)/);
    assert.match(init, /register_hook\("pre_tool_call"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('hermes', home, cwd, 'install').status, 0);
    const res = run('hermes', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.hermes', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.hermes', 'huaweicloud-plugins')));
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    if (existsSync(allowlistPath)) {
      const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as HermesAllowlist;
      const remains = (allowlist.approvals || []).some((a) => {
        const cmd = typeof a === 'string' ? a : a?.command;
        return typeof cmd === 'string' && cmd.includes('huaweicloud-safety.py');
      });
      assert.ok(!remains, 'uninstall must remove the safety hook approval from the allowlist');
    }
    assert.ok(
      !existsSync(join(home, '.hermes', 'plugins', 'huaweicloud-safety')),
      'uninstall must remove the safety hook plugin',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('atomcode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[AtomCode\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.atomcode', 'huaweicloud-plugins');
    assertNativeCoreDisclosure(join(home, '.atomcode', 'skills'), pd);
    assert.ok(existsSync(join(pd, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pd, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
    const mcpCfg = JSON.parse(readFileSync(join(home, '.atomcode', 'mcp.json'), 'utf8'));
    assert.equal(mcpCfg.mcpServers['huaweicloud-devkit'].command, 'node');
    assert.ok(mcpCfg.mcpServers['huaweicloud-devkit'].args[0].endsWith('huaweicloud-plugins/dist/mcp-server.js'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    const res = run('atomcode', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    const res = run('atomcode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.atomcode', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.atomcode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    assertNativeCoreDisclosure(join(home, '.atomcode', 'skills'), join(home, '.atomcode', 'huaweicloud-plugins'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The plugin-dir skills tree is pruned on update: a retired skill name must
// not keep serving stale, ungated content through retrieve_skill.
test('update prunes retired skills from the plugin-dir tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const pluginSkillsDir = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
    mkdirSync(join(pluginSkillsDir, 'huawei-retired'), { recursive: true });
    writeFileSync(join(pluginSkillsDir, 'huawei-retired', 'SKILL.md'), '---\nname: huawei-retired\n---\nstale\n');
    mkdirSync(join(pluginSkillsDir, 'user-foreign'), { recursive: true });
    writeFileSync(join(pluginSkillsDir, 'user-foreign', 'SKILL.md'), '---\nname: user-foreign\n---\nuser\n');
    const res = run('opencode', home, cwd, 'update');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!existsSync(join(pluginSkillsDir, 'huawei-retired')), 'retired devkit skill must be pruned');
    assert.ok(existsSync(join(pluginSkillsDir, 'user-foreign')), 'foreign dir without huawei prefix survives');
    assert.ok(countSkills(pluginSkillsDir) >= 6, 'shipped tree intact');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex target does not crash without Codex CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const emptyPath = join(cwd, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    const res = run('codex', home, cwd, 'install', { PATH: emptyPath });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex CLI not found/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install uses DevKit plugin id and skips OpenCode marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'install', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /@huaweicloud-devkit/);
    assert.match(res.stdout, /Installation complete/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","add","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.doesNotMatch(log, /huaweicloud-core@huaweicloud-devkit/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install fails fast when plugin add fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd, { failPluginAdd: true });
    const res = run('codex', home, cwd, 'install', env);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex plugin installation failed/);
    assert.match(res.stdout, /Installation failed for: codex/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex status parses plugin list JSON (name match, not path substring)', () => {
  // Installed plugin by name → Installed
  {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const env = fakeCodexEnv(cwd, {
        listJson: JSON.stringify({
          installed: [{ name: 'huaweicloud-devkit', pluginId: 'huaweicloud-devkit@personal' }],
        }),
      });
      const res = run('codex', home, cwd, 'status', env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Plugin:.*Installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  // Legacy name huaweicloud-core in a PATH is no longer treated as installed (#501).
  {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const env = fakeCodexEnv(cwd, {
        listJson: JSON.stringify({
          installed: [
            { name: 'documents', pluginId: 'documents@x', source: { path: 'C:/pkg/plugins/huaweicloud-core' } },
          ],
        }),
      });
      const res = run('codex', home, cwd, 'status', env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Plugin:.*Not installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('codex uninstall removes current and legacy plugin ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'uninstall', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-devkit@huaweicloud-devkit/);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-core@huaweicloud-devkit/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","remove","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.match(log, /"plugin","remove","huaweicloud-core@huaweicloud-devkit"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex uninstall keeps the plugin cache when marketplace remove fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex', home, cwd, 'install', fakeCodexEnv(cwd)).status, 0);
    // Seed the marketplace-keyed cache shell `codex plugin remove` leaves
    // behind (live-verified on codex-cli 0.162.1).
    const cacheDir = join(home, '.codex', 'plugins', 'cache', getMarketplaceName());
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'marker'), 'x');

    const res = run('codex', home, cwd, 'uninstall', fakeCodexEnv(cwd, { failMarketplaceRemove: true }));
    assert.equal(res.status, 0, res.stderr);
    // The safety gate: a failed `codex plugin marketplace remove` leaves the
    // registration potentially live, so its cache must survive the uninstall
    // (deleting it would break a still-registered plugin).
    assert.ok(existsSync(join(cacheDir, 'marker')), 'failed marketplace remove must keep the plugin cache');

    // Positive twin: a successful marketplace remove opens the gate and
    // cleans the cache (the fake-CLI pin; real-agents covers the real CLI).
    const again = run('codex', home, cwd, 'uninstall', fakeCodexEnv(cwd));
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!existsSync(join(cacheDir, 'marker')), 'successful marketplace remove must clean the plugin cache');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect with multiple agents requires explicit target in non-interactive shells', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAuto(home, cwd, 'install');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Multiple agents detected \(opencode, workbuddy\)/);
    assert.match(res.stderr, /non-interactive shell/);
    assert.match(res.stderr, /--target <agent>.*--target all/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')), 'no partial install');
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins')), 'no partial install');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The PTY-driven interactive tests below shell out through util-linux
// `script -qec` and /bin/bash — Linux-only flags and paths. The guard is
// "run only on Linux" (not "skip on Windows") so a future macOS matrix leg
// skips these instead of failing on BSD script's different flag set.
const ptySkip = process.platform !== 'linux' ? 'PTY-driven tests require util-linux script' : false;

function runAutoPty(
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

function runAutoPtyStaged(
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
function seedProvisionedBinaries(home: string) {
  const binDir = join(home, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeHcloud = join(binDir, 'hcloud');
  writeFileSync(fakeHcloud, `#!/bin/sh\necho "Current KooCLI version: ${pkg.kooCliVersion}"\n`, 'utf8');
  chmodSync(fakeHcloud, 0o755);
  const fakeGateway = join(binDir, 'huaweicloud-open-mcp');
  writeFileSync(fakeGateway, '#!/bin/sh\n', 'utf8');
  chmodSync(fakeGateway, 0o755);
}

test('install auto-detect multiple agents interactive multi-select picks only chosen ones', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', '1\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit to opencode/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')), 'opencode installed');
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins', '.installed')), 'workbuddy not installed');
    assert.doesNotMatch(res.stdout, /\[WorkBuddy\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect multiple agents interactive multi-select picks all on comma list', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', '1,2\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit to opencode, workbuddy/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')), 'opencode installed');
    assert.ok(existsSync(join(home, '.workbuddy', 'huaweicloud-plugins', '.installed')), 'workbuddy installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect multiple agents interactive cancel installs nothing', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', '0\n');
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')), 'nothing installed on cancel');
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins')), 'nothing installed on cancel');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install --target all still installs every supported agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  const pluginDirs = [
    join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    join(home, 'plugins', 'huaweicloud-devkit'),
    join(home, '.codeartsdoer', 'huaweicloud-plugins'),
    join(home, '.codeartswork', 'huaweicloud-plugins'),
    join(home, '.workbuddy', 'huaweicloud-plugins'),
    join(home, '.dsh', 'huaweicloud-plugins'),
    join(home, '.office-claw', 'huaweicloud-plugins'),
    join(home, '.hermes', 'huaweicloud-plugins'),
    join(home, '.agents', 'huaweicloud-plugins'),
    join(home, '.atomcode', 'huaweicloud-plugins'),
  ];
  try {
    const res = run('all', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    for (const dir of pluginDirs) {
      assert.ok(existsSync(join(dir, '.installed')), `install marker missing for ${dir}`);
    }
    assert.match(res.stdout, /\[AtomCode\]/);
    assert.match(res.stdout, /\[CodeArts\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect single agent installs only that agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const res = runAuto(home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit for opencode/);
    assertNativeCoreDisclosure(
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    );
    assert.ok(!existsSync(join(home, '.workbuddy')), 'workbuddy must not be created');
    assert.doesNotMatch(res.stdout, /\[WorkBuddy\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect with no agents reports error', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = runAuto(home, cwd, 'install');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No supported agent detected/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('status auto-detect multiple retains full-range behavior (install-only change)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAuto(home, cwd, 'status');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /\[AtomCode\]/, 'status still reaches all targets under auto-detect');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect multiple agents interactive multi-select installs all on "all"', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', 'all\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit to opencode, workbuddy/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')), 'opencode installed');
    assert.ok(existsSync(join(home, '.workbuddy', 'huaweicloud-plugins', '.installed')), 'workbuddy installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install auto-detect multiple agents invalid input falls back to all detected', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', '9\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Invalid selection: "9"/);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit to opencode, workbuddy/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')), 'opencode installed');
    assert.ok(existsSync(join(home, '.workbuddy', 'huaweicloud-plugins', '.installed')), 'workbuddy installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install rejects unknown --target', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('bogus', home, cwd, 'install');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unknown target: bogus/);
    assert.match(res.stderr, /Supported:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall auto-detect multiple retains full-range behavior (install-only change)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = runAuto(home, cwd, 'uninstall');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /\[AtomCode\]/, 'uninstall still reaches all targets under auto-detect');
    assert.match(res.stdout, /\[Hermes Agent\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 1 installs to the entered target', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = runAutoPty(home, cwd, 'install', '1\nopencode\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit for opencode/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 1 rejects unknown target', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = runAutoPty(home, cwd, 'install', '1\nbogus\n');
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Unknown target: bogus/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')), 'nothing installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 2 installs to all', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.office-claw'), { recursive: true });
    writeFileSync(join(home, '.office-claw', 'capabilities.json'), '{}');
    const res = runAutoPtyStaged(home, cwd, 'install', ['2', 30, home]);
    assert.match(res.stdout, /Installing HuaweiCloud DevKit for all/);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
    assert.ok(existsSync(join(home, '.atomcode', 'huaweicloud-plugins', '.installed')));
    // OfficeAce installs cleanly now: native skill registration is gone, so a
    // capabilities.json without a capabilities array no longer fails the step.
    assert.ok(existsSync(join(home, '.office-claw', 'huaweicloud-plugins', '.installed')));
    assert.doesNotMatch(res.stdout, /Installation failed for/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 0 exits without installing', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = runAutoPty(home, cwd, 'install', '0\n');
    assert.equal(res.status, 1);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')), 'nothing installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 3 writes Claude Code MCP config with backup', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ existing: true }));
    const res = runAutoPty(home, cwd, 'install', '3\n');
    assert.equal(res.status, 0, res.stderr);
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.existing, true);
    assert.equal(cfg.mcpServers['huaweicloud-devkit'].command, 'npx');
    assert.ok(existsSync(join(home, '.claude.json.bak')), 'backup created');
    assert.match(res.stdout, /Restart the session to apply/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 3 writes Cursor mcp.json', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const res = runAutoPty(home, cwd, 'install', '3\n');
    assert.equal(res.status, 0, res.stderr);
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cfg.mcpServers['huaweicloud-devkit'].command, 'npx');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 3 skips already-configured MCP', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const existing = { mcpServers: { 'huaweicloud-devkit': { command: 'custom' } } };
    writeFileSync(join(home, '.claude.json'), JSON.stringify(existing));
    const res = runAutoPty(home, cwd, 'install', '3\n');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /already configured; skipping/);
    assert.ok(!existsSync(join(home, '.claude.json.bak')), 'no backup written when skipped');
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.mcpServers['huaweicloud-devkit'].command, 'custom');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install zero-detect menu option 3 prints snippet when no MCP agent detected', { skip: ptySkip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = runAutoPty(home, cwd, 'install', '3\n');
    assert.equal(res.status, 1);
    assert.match(res.stdout, /config snippet you can paste/);
    assert.match(res.stdout, /huaweicloud-devkit-mcp/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
