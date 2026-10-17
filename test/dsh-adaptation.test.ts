import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home: string, dshHome: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    DSH_HOME: dshHome,
    HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL: '1',
  };
  // cleanupNativeDirs() runs inside every install and reconciles EVERY
  // target's native dir (not just dsh), each resolved from its own ambient
  // override — clear the ones this file does not pin.
  for (const key of [
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'HERMES_HOME',
    'ATOMCODE_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'HUAWEICLOUD_HOME',
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(home: string, cwd: string, args: string[], dshHome: string = join(home, '.dsh')) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home, dshHome),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function countSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function readPatch(dshHome: string): string {
  const patchFile = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  return existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
}

function countMcpRows(patch: string): number {
  return (patch.match(/id: (?:huaweicloud-devkit|mcp-huaweicloud)/g) || []).length;
}

test('dsh install copies skills, MCP server, safety policy, and patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh-custom');
    const res = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[DSH\]/);
    assert.match(res.stdout, /Installation complete!/);

    assert.ok(countSkills(join(dshHome, 'huaweicloud-plugins', 'skills')) >= 6, 'DSH skills tree in plugin dir');
    // Plugin-dir layout: the core meta-skills are ALSO natively disclosed.
    const nativeCore = parseCoreSkillNames(
      readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8'),
    );
    assert.ok(nativeCore, 'manifest core roster must parse');
    assert.equal(
      countSkills(join(dshHome, 'skills')),
      nativeCore.size,
      'native DSH skills dir carries the core meta-skills',
    );
    assert.ok(existsSync(join(dshHome, 'skills', '.huaweicloud-devkit-native.json')));
    const pluginDir = join(dshHome, 'huaweicloud-plugins');
    assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')));
    assert.ok(existsSync(join(pluginDir, 'dist', 'tools.js')));
    assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pluginDir, '.installed')));
    assert.equal(
      JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version,
      pkg.version,
      'dsh plugin package.json version matches package',
    );

    const patch = readPatch(dshHome);
    assert.match(patch, /id: huaweicloud-devkit/);
    assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(patch, /serverName: huaweicloud/);
    assert.match(patch, /transport: stdio/);
    assert.match(patch, /failOnStartupError: false/);
    assert.match(patch, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: local/);
    assert.match(patch, /id: huaweicloud-hook/);
    assert.match(patch, /huaweicloud-plugins\/hook-plugin\.mjs/);
    assert.doesNotMatch(patch, /\\/);
    assert.match(patch, /huaweicloud-plugins\/dist\/mcp-server\.js/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh install writes .installed marker only after runtime deps', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const res = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(res.status, 0, res.stderr);
    const pluginDir = join(dshHome, 'huaweicloud-plugins');
    assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker exists');
    const hasUndici = existsSync(join(pluginDir, 'node_modules', 'undici'));
    assert.ok(hasUndici, 'undici installed before .installed marker written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh install is idempotent and preserves unrelated patch entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    const patchFile = join(profileDir, 'cordis.patch.yml');
    const existingPatch = [
      '# user patch',
      '- insert:',
      '    - id: user-plugin',
      "      name: '@example/user-plugin'",
      '',
    ].join('\n');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(patchFile, existingPatch);

    const first = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(first.status, 0, first.stderr);
    const second = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(second.status, 0, second.stderr);

    const patch = readPatch(dshHome);
    assert.equal(countMcpRows(patch), 1, patch);
    assert.match(patch, /id: user-plugin/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh update migrates a pre-2.0 patch path to dist', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    // Rewrite the installed patch into the pre-2.0 shape: bundle markers plus
    // the absolute src/mcp-server.mjs path the old postinstall baked in.
    const patchFile = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const oldCache = '/old/npx-cache/lib/node_modules/huaweicloud-devkit';
    writeFileSync(
      patchFile,
      [
        '- insert:',
        '    - id: huaweicloud-devkit',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: huaweicloud',
        '        transport: stdio',
        '        command: node',
        '        args:',
        `          - '${oldCache}/plugins/huaweicloud-core/src/mcp-server.mjs'`,
        '        failOnStartupError: false',
        '',
      ].join('\n'),
    );

    const update = runCli(home, cwd, ['update', '--target', 'dsh'], dshHome);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /DSH patch MCP path migrated to dist/);

    const patch = readPatch(dshHome);
    assert.match(patch, /plugins\/huaweicloud-core\/dist\/mcp-server\.js/);
    assert.doesNotMatch(patch, /src\/mcp-server\.mjs/);
    assert.equal(countMcpRows(patch), 1, patch);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh update refreshes installed files and keeps one patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const update = runCli(home, cwd, ['update', '--target', 'dsh'], dshHome);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /Update complete/);

    assert.ok(existsSync(join(dshHome, 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
    assert.ok(countSkills(join(dshHome, 'huaweicloud-plugins', 'skills')) >= 6, 'skills tree refreshed in plugin dir');
    assert.equal(countMcpRows(readPatch(dshHome)), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh status reports installed files and patch configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const status = runCli(home, cwd, ['status', '--target', 'dsh'], dshHome);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /\[DSH\]/);
    assert.match(status.stdout, /MCP Server: .*Installed/);
    assert.match(status.stdout, /Safety Policy: .*Installed/);
    assert.match(status.stdout, /Skills: .*\d+ installed/);
    assert.match(status.stdout, /DSH patch: .*Configured/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh uninstall removes installed files and only the managed patch row', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const uninstall = runCli(home, cwd, ['uninstall', '--target', 'dsh'], dshHome);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /Uninstall complete\./);

    assert.equal(countSkills(join(dshHome, 'skills')), 0, 'DSH skills removed');
    assert.ok(!existsSync(join(dshHome, 'skills')), 'empty DSH skills dir removed');
    assert.ok(!existsSync(join(dshHome, 'huaweicloud-plugins')), 'DSH plugin dir removed');
    const patch = readPatch(dshHome);
    assert.equal(countMcpRows(patch), 0, patch);
    assert.doesNotMatch(patch, /@deepseek-ai\/dsh-mcp-client/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dsh uninstall preserves non-Huawei skills directory entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const customSkillDir = join(dshHome, 'skills', 'custom-skill');
    mkdirSync(customSkillDir, { recursive: true });
    writeFileSync(join(customSkillDir, 'SKILL.md'), 'name: custom-skill\n');

    const install = runCli(home, cwd, ['install', '--target', 'dsh'], dshHome);
    assert.equal(install.status, 0, install.stderr);

    const uninstall = runCli(home, cwd, ['uninstall', '--target', 'dsh'], dshHome);
    assert.equal(uninstall.status, 0, uninstall.stderr);

    assert.ok(existsSync(customSkillDir), 'custom skill preserved');
    assert.equal(countSkills(join(dshHome, 'skills')), 0, 'Huawei skills removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('bundled cordis.patch.yml has no self loader entry and only the MCP insert', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: huaweicloud-devkit/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.doesNotMatch(patch, /name: huaweicloud-devkit/, 'must not import itself as a loader entry');
  assert.equal(countMcpRows(patch), 1, 'exactly one insert entry');
});

// The npm-in-profile layout: postinstall maintains ~/.dsh/skills itself (the
// MCP server runs from the package root, not a plugin dir). It must sync the
// core meta-skills, purge non-core owned names, and write the receipt — and
// refuse to mutate anything when the manifest lacks pack info.
test('dsh bundle postinstall syncs core skills natively and purges non-core', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    // A minimal package layout: bin/ + patch + the compiled shared libs the
    // postinstall requires + a skills tree with manifest.
    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));
    const stagedLib = join(stage, 'plugins', 'huaweicloud-core', 'dist', 'lib');
    mkdirSync(stagedLib, { recursive: true });
    for (const lib of ['native-receipt.js', 'skill-manifest.js']) {
      copyFileSync(join(root, 'plugins', 'huaweicloud-core', 'dist', 'lib', lib), join(stagedLib, lib));
    }
    const stagedSkills = join(stage, 'plugins', 'huaweicloud-core', 'skills');
    const realSkills = join(root, 'plugins', 'huaweicloud-core', 'skills');
    mkdirSync(stagedSkills, { recursive: true });
    copyFileSync(join(realSkills, '.manifest.json'), join(stagedSkills, '.manifest.json'));
    for (const name of ['huaweicloud-core', 'huaweicloud-safety', 'huawei-ecs']) {
      mkdirSync(join(stagedSkills, name), { recursive: true });
      copyFileSync(join(realSkills, name, 'SKILL.md'), join(stagedSkills, name, 'SKILL.md'));
    }

    // Pre-existing residue in the native dir: a stale service copy (owned,
    // non-core), a user skill sharing the prefix, and a forged receipt
    // claiming a retired core name (valid shape: deletable) plus a
    // user-content name (invalid shape: must never earn delete rights).
    const nativeDir = join(dshHome, 'skills');
    mkdirSync(join(nativeDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(nativeDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\nstale\n');
    mkdirSync(join(nativeDir, 'huawei-my-runbook'), { recursive: true });
    writeFileSync(join(nativeDir, 'huawei-my-runbook', 'SKILL.md'), '---\nname: huawei-my-runbook\n---\nuser\n');
    mkdirSync(join(nativeDir, 'huaweicloud-retired-x'), { recursive: true });
    writeFileSync(join(nativeDir, 'huaweicloud-retired-x', 'SKILL.md'), '---\nname: x\n---\nretired\n');
    mkdirSync(join(nativeDir, 'steal-me'), { recursive: true });
    writeFileSync(join(nativeDir, 'steal-me', 'SKILL.md'), '---\nname: steal-me\n---\nuser\n');
    writeFileSync(
      join(nativeDir, '.huaweicloud-devkit-native.json'),
      JSON.stringify({ names: ['huaweicloud-retired-x', 'steal-me'] }),
    );

    const res = spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
      cwd: profileDir,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /rewrote DSH patch MCP path/);
    assert.match(res.stdout, /refreshed 2 core skill cop/);
    // The fixture stages only 2 of the 6 core dirs: the manifest claims the
    // other 4 and the postinstall must warn, not crash the npm install.
    assert.match(res.stderr, /claimed by the manifest but missing from the package tree: huaweicloud-/);
    // A broken package must not be promised availability in the same
    // output — the hint is gated on package health.
    assert.ok(
      !res.stdout.includes('MCP server will be available'),
      'the availability hint must not follow a refuse-to-start diagnosis',
    );

    assert.ok(existsSync(join(nativeDir, 'huaweicloud-core')), 'core skill synced natively');
    assert.ok(existsSync(join(nativeDir, 'huaweicloud-safety')), 'core skill synced natively');
    assert.ok(
      !existsSync(join(nativeDir, 'huawei-ecs')),
      'owned non-core name stays off the native surface (stale copy purged)',
    );
    assert.ok(existsSync(join(nativeDir, 'huawei-my-runbook')), 'user skill sharing the prefix survives');
    assert.ok(
      !existsSync(join(nativeDir, 'huaweicloud-retired-x')),
      'a receipt-remembered retired core name is deletable',
    );
    assert.ok(
      existsSync(join(nativeDir, 'steal-me')),
      'a receipt name outside the core-skill shape must never earn delete rights',
    );
    assert.ok(existsSync(join(nativeDir, '.huaweicloud-devkit-native.json')));
    const receipt = JSON.parse(readFileSync(join(nativeDir, '.huaweicloud-devkit-native.json'), 'utf8'));
    assert.equal(receipt.names.length, 2, 'receipt rewritten to the actually-placed roster');
    assert.equal(receipt.layout, 'package-root', 'the marketplace receipt records its layout');
    assert.equal(receipt.packageRoot, stage, 'the marketplace receipt records the package root');
    assert.equal(
      readFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), 'utf8'),
      readFileSync(join(stagedSkills, 'huaweicloud-core', 'SKILL.md'), 'utf8'),
      'native copy is byte-equal to the package tree',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

// A staged package without dist/ is broken (the server cannot start), but
// the postinstall must still not fail the npm install: warn on stderr,
// skip the native sync, leave the destination untouched.
test('dsh bundle postinstall warns and exits 0 when dist is missing from the package', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));
    const stagedSkills = join(stage, 'plugins', 'huaweicloud-core', 'skills');
    const realSkills = join(root, 'plugins', 'huaweicloud-core', 'skills');
    mkdirSync(stagedSkills, { recursive: true });
    copyFileSync(join(realSkills, '.manifest.json'), join(stagedSkills, '.manifest.json'));
    mkdirSync(join(stagedSkills, 'huaweicloud-core'), { recursive: true });
    copyFileSync(join(realSkills, 'huaweicloud-core', 'SKILL.md'), join(stagedSkills, 'huaweicloud-core', 'SKILL.md'));

    const nativeDir = join(dshHome, 'skills');
    mkdirSync(join(nativeDir, 'huawei-preexisting'), { recursive: true });
    writeFileSync(join(nativeDir, 'huawei-preexisting', 'SKILL.md'), '---\nname: x\n---\n', 'utf8');

    const res = spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
      cwd: profileDir,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, `postinstall must not fail the npm install: ${res.stderr}`);
    assert.match(res.stdout, /rewrote DSH patch MCP path/);
    assert.match(res.stderr, /dist\/ missing or unreadable/);
    assert.ok(!existsSync(join(nativeDir, '.huaweicloud-devkit-native.json')), 'no receipt written');
    assert.ok(
      existsSync(join(nativeDir, 'huawei-preexisting')),
      'the native dir is left untouched when the package is broken',
    );
    assert.ok(
      !res.stdout.includes('MCP server will be available'),
      'the availability hint must not follow a refuse-to-start diagnosis',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

// Destination-side failure (locked/occupied skills dir) must warn and leave
// the npm install green — the same warn-and-continue contract the setup
// CLI's syncNativeCoreSkills carries.
test('dsh bundle postinstall warns and exits 0 when the native dir cannot be created', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));
    const stagedLib = join(stage, 'plugins', 'huaweicloud-core', 'dist', 'lib');
    mkdirSync(stagedLib, { recursive: true });
    for (const lib of ['native-receipt.js', 'skill-manifest.js']) {
      copyFileSync(join(root, 'plugins', 'huaweicloud-core', 'dist', 'lib', lib), join(stagedLib, lib));
    }
    const stagedSkills = join(stage, 'plugins', 'huaweicloud-core', 'skills');
    const realSkills = join(root, 'plugins', 'huaweicloud-core', 'skills');
    mkdirSync(stagedSkills, { recursive: true });
    copyFileSync(join(realSkills, '.manifest.json'), join(stagedSkills, '.manifest.json'));
    // A COMPLETE core tree: the package is healthy, so a destination-side
    // failure still leaves the availability hint on — the hint follows
    // package health, not the disclosure layer's success.
    const core = parseCoreSkillNames(readFileSync(join(realSkills, '.manifest.json'), 'utf8'));
    assert.ok(core, 'manifest core roster must parse');
    for (const name of core) {
      mkdirSync(join(stagedSkills, name), { recursive: true });
      copyFileSync(join(realSkills, name, 'SKILL.md'), join(stagedSkills, name, 'SKILL.md'));
    }

    // The native skills dir path is occupied by a regular file.
    mkdirSync(join(dshHome), { recursive: true });
    writeFileSync(join(dshHome, 'skills'), 'occupied by a file');

    const res = spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
      cwd: profileDir,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, `postinstall must not fail the npm install: ${res.stderr}`);
    assert.match(res.stdout, /rewrote DSH patch MCP path/);
    assert.match(res.stderr, /native core skills not synced .* MCP disclosure remains authoritative/);
    assert.match(
      res.stdout,
      /MCP server will be available after DSH restart/,
      'a healthy package keeps the availability hint despite the destination failure',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

// The discriminating cell for the availability-hint gate: a BROKEN package
// (partial core tree) that ALSO fails the destination write. The catch must
// return the real package health, so the refuse-to-start diagnosis and the
// availability promise never share one output — reverting the catch to an
// unconditional true passes every other test and fails only here.
test('dsh bundle postinstall suppresses the availability hint when a broken package also fails the destination', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));
    const stagedLib = join(stage, 'plugins', 'huaweicloud-core', 'dist', 'lib');
    mkdirSync(stagedLib, { recursive: true });
    for (const lib of ['native-receipt.js', 'skill-manifest.js']) {
      copyFileSync(join(root, 'plugins', 'huaweicloud-core', 'dist', 'lib', lib), join(stagedLib, lib));
    }
    const stagedSkills = join(stage, 'plugins', 'huaweicloud-core', 'skills');
    const realSkills = join(root, 'plugins', 'huaweicloud-core', 'skills');
    mkdirSync(stagedSkills, { recursive: true });
    copyFileSync(join(realSkills, '.manifest.json'), join(stagedSkills, '.manifest.json'));
    // Partial tree (2 of 6): the package is broken.
    for (const name of ['huaweicloud-core', 'huaweicloud-safety']) {
      mkdirSync(join(stagedSkills, name), { recursive: true });
      copyFileSync(join(realSkills, name, 'SKILL.md'), join(stagedSkills, name, 'SKILL.md'));
    }

    // AND the destination write fails: the skills path is a regular file.
    mkdirSync(join(dshHome), { recursive: true });
    writeFileSync(join(dshHome, 'skills'), 'occupied by a file');

    const res = spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
      cwd: profileDir,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, `postinstall must not fail the npm install: ${res.stderr}`);
    assert.match(res.stdout, /rewrote DSH patch MCP path/);
    assert.match(res.stderr, /claimed by the manifest but missing from the package tree/);
    assert.match(res.stderr, /native core skills not synced .* MCP disclosure remains authoritative/);
    assert.ok(
      !res.stdout.includes('MCP server will be available'),
      'a broken package must never be promised availability, even when the destination also fails',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('dsh bundle postinstall rewrites relative MCP path to absolute', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));

    const res = spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
      cwd: profileDir,
      env: makeEnv(home, dshHome),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /rewrote DSH patch MCP path/);

    const patch = readFileSync(join(stage, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id: huaweicloud-devkit/);
    assert.match(patch, /mcp-server\.js/);
    assert.doesNotMatch(patch, /'\.\//, 'no relative MCP path left');
    assert.doesNotMatch(patch, /\\/, 'forward slashes only');
    assert.ok(
      patch.includes(`'${stage.replaceAll('\\', '/')}/plugins/huaweicloud-core/dist/mcp-server.js'`),
      'absolute staged package path',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('dsh bundle postinstall is idempotent when MCP path is already absolute', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-pkg-'));
  try {
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });

    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(join(root, 'bin', 'dsh-postinstall.cjs'), join(stage, 'bin', 'dsh-postinstall.cjs'));
    copyFileSync(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'));

    const run = () =>
      spawnSync(process.execPath, [join(stage, 'bin', 'dsh-postinstall.cjs')], {
        cwd: profileDir,
        env: makeEnv(home, dshHome),
        encoding: 'utf8',
        timeout: 60000,
      });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = readFileSync(join(stage, 'cordis.patch.yml'), 'utf8');

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /rewrote DSH patch MCP path/, 'second run is a no-op');
    const afterSecond = readFileSync(join(stage, 'cordis.patch.yml'), 'utf8');
    assert.equal(afterSecond, afterFirst, 'patch unchanged on second run');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('cli help documents the dsh target', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-proj-'));
  try {
    const res = runCli(home, cwd, ['help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
    );
    assert.match(res.stdout, /install --target dsh/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
