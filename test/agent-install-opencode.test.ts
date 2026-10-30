import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNativeCoreDisclosure,
  assertServerPayload,
  countSkills,
  pkg,
  pluginVersion,
  ptySkip,
  run,
  runAuto,
  runAutoPty,
  runAutoPtyStaged,
} from './agent-install-harness.ts';

test('opencode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assertServerPayload(pd);
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
    assertServerPayload(pd);
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

test('workbuddy telemetry dirs follow HUAWEICLOUD_DEVKIT_HOME (port-v2defects)', () => {
  // The global telemetry dir (~/.huaweicloud-devkit/telemetry) must ride the
  // telemetry face's HUAWEICLOUD_DEVKIT_HOME-aware derivation on BOTH the
  // install mkdir and the uninstall rmSync: the bare homedir() join created
  // an orphan dir under the real/fake HOME while the server (whose
  // GLOBAL_TELEMETRY_DIR honors the override) wrote under the override —
  // and uninstall deleted the HOME twin, leaving the override's behind.
  // The dir creation sits inside deployWorkBuddyHooks' python-gated block
  // (steps 1-4 share the early return), so the fake home carries WorkBuddy's
  // managed Python to drive the real path — the harness's fake HOME has
  // none, which would skip the whole block and test nothing.
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  const override = mkdtempSync(join(tmpdir(), 'ai-devkit-home-'));
  try {
    const managedPython = join(home, '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
    mkdirSync(dirname(managedPython), { recursive: true });
    writeFileSync(managedPython, '#!/bin/sh\n', 'utf8');
    const res = run('workbuddy', home, cwd, 'install', { HUAWEICLOUD_DEVKIT_HOME: override });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      existsSync(join(override, '.huaweicloud-devkit', 'telemetry')),
      'global telemetry dir must be created under the override',
    );
    assert.ok(
      !existsSync(join(home, '.huaweicloud-devkit')),
      'no orphan .huaweicloud-devkit under the bare HOME (nothing else creates it there)',
    );
    const uninstall = run('workbuddy', home, cwd, 'uninstall', { HUAWEICLOUD_DEVKIT_HOME: override });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    // The stdout line is location-bearing (interrogate round 1): the removed
    // path printed must be the OVERRIDE twin, not the bare-HOME one.
    assert.match(
      uninstall.stdout,
      /Removed telemetry cache: .*ai-devkit-home-[^\s]*[.]huaweicloud-devkit[\\/]telemetry/,
    );
    assert.ok(
      !existsSync(join(override, '.huaweicloud-devkit', 'telemetry')),
      'uninstall must remove the override dir the install created',
    );
    // Pre-existing uninstall shape, pinned explicitly (interrogate round 1):
    // the rmSync targets the telemetry CHILD — the now-empty
    // .huaweicloud-devkit parent survives under the override exactly as the
    // bare-home parent did pre-fix. Recorded, not changed: removing the
    // parent would need an emptiness guard and buys nothing (the dir is
    // devkit-namespaced and self-heals on the next install/server write).
    assert.ok(
      existsSync(join(override, '.huaweicloud-devkit')),
      'the empty parent dir remains (pre-existing shape, pinned deliberately)',
    );
    assert.ok(
      !existsSync(join(home, '.huaweicloud-devkit')),
      'the bare HOME stays clean through install and uninstall',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(override, { recursive: true, force: true });
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
    assertServerPayload(pd);
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
    assertServerPayload(pd);
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
    // OfficeAce needs a usable config root to install for real (the marker
    // now means "payload placed" — a no-op officeace step correctly leaves
    // none, where the old command layer wrote a lying marker).
    mkdirSync(join(home, '.office-claw'), { recursive: true });
    writeFileSync(join(home, '.office-claw', 'capabilities.json'), '{}');
    const res = run('all', home, cwd, 'install', { OFFICE_CLAW_CONFIG_ROOT: join(home, '.office-claw') });
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
