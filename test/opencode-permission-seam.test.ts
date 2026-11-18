import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  applySkillTreePermissionSeam,
  opencodeSeamVersionSupported,
  payloadEditDenyGlobs,
  removeSkillTreePermissionSeam,
  skillTreePermissionGlobs,
} from '../plugins/huaweicloud-core/src/lib/opencode-permission-seam.ts';
import { fixtureDir } from './fixture-dir.ts';
import { npmCacheEnv } from './npm-cache.ts';

// ── Part A: pure seam logic (lib/opencode-permission-seam.ts) ──
// The ownership contract is add-only-if-absent on write and value-exact on
// removal; these units pin every branch the CLI integration cannot reach
// deterministically (user rules, scalar shapes, the accepted same-value
// edge, the version floor's polarity).

test('skillTreePermissionGlobs covers the plugin tree plus sorted per-skill native globs', () => {
  const globs = skillTreePermissionGlobs('/fake/plugin/skills', '/fake/native/skills', [
    'huaweicloud-core',
    'huaweicloud-safety',
    'huaweicloud-api-and-sdk',
  ]);
  assert.deepEqual(globs, [
    '/fake/plugin/skills/**',
    '/fake/native/skills/huaweicloud-api-and-sdk/**',
    '/fake/native/skills/huaweicloud-core/**',
    '/fake/native/skills/huaweicloud-safety/**',
  ]);
  assert.deepEqual(
    skillTreePermissionGlobs('C:\\fake\\plugin\\skills', 'C:\\fake\\native\\skills', []),
    ['C:/fake/plugin/skills/**'],
    'backslash inputs are forward-slashed (the mcpPath precedent)',
  );
});

test('payloadEditDenyGlobs derives the forward-slashed payload-root glob', () => {
  assert.deepEqual(payloadEditDenyGlobs('/fake/config/opencode/huaweicloud-plugins'), [
    '/fake/config/opencode/huaweicloud-plugins/**',
  ]);
  assert.deepEqual(payloadEditDenyGlobs('C:\\fake\\huaweicloud-plugins'), ['C:/fake/huaweicloud-plugins/**']);
});

test('apply writes the edit-only deny without an external allow for the payload glob', () => {
  const config: Record<string, unknown> = {};
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**'], ['/t/huaweicloud-plugins/**']);
  assert.deepEqual(result, { changed: true, skipped: [] });
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.deepEqual(permission.external_directory, { '/t/skills/**': 'allow' });
  assert.deepEqual(permission.edit, { '/t/skills/**': 'deny', '/t/huaweicloud-plugins/**': 'deny' });
});

test('a user-owned edit value on the payload glob survives; missing skills globs still write', () => {
  const config = { permission: { edit: { '/t/huaweicloud-plugins/**': 'allow' } } };
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**'], ['/t/huaweicloud-plugins/**']);
  assert.equal(result.changed, true);
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.equal(permission.edit['/t/huaweicloud-plugins/**'], 'allow', 'the user value is kept');
  assert.equal(permission.edit['/t/skills/**'], 'deny');
  assert.deepEqual(permission.external_directory, { '/t/skills/**': 'allow' });
});

test('remove deletes the payload edit deny value-exact and prunes seam-emptied sections', () => {
  const config = {
    permission: {
      external_directory: { '/u/**': 'allow', '/t/skills/**': 'allow' },
      edit: { '/t/skills/**': 'deny', '/t/huaweicloud-plugins/**': 'deny' },
    },
  };
  const changed = removeSkillTreePermissionSeam(config, ['/t/skills/**'], ['/t/huaweicloud-plugins/**']);
  assert.equal(changed, true);
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.deepEqual(permission.external_directory, { '/u/**': 'allow' });
  assert.equal('edit' in permission, false, 'the edit section was emptied by OUR deletions and pruned');
});

test('applySkillTreePermissionSeam writes allow+deny for every glob on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.deepEqual(result, { changed: true, skipped: [] });
  assert.deepEqual(config.permission, {
    external_directory: { '/t/skills/**': 'allow' },
    edit: { '/t/skills/**': 'deny' },
  });
});

test('a pre-existing rule on a devkit glob survives the seam write, whatever its value', () => {
  const config = {
    permission: {
      external_directory: { '/t/skills/**': 'ask' },
      edit: { '/t/skills/**': 'allow' },
    },
  };
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(result.changed, false, 'both sections are user-owned — nothing to write');
  assert.deepEqual(result.skipped, []);
  assert.equal((config.permission as Record<string, unknown>) === config.permission, true);
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.equal(permission.external_directory['/t/skills/**'], 'ask');
  assert.equal(permission.edit['/t/skills/**'], 'allow');
});

test('a user-owned section keeps its glob while the sibling section still gets its write', () => {
  const config = { permission: { external_directory: { '/t/skills/**': 'ask' } } };
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(result.changed, true, 'the edit section is still missing its glob');
  assert.deepEqual(result.skipped, []);
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.equal(permission.external_directory['/t/skills/**'], 'ask', 'user value untouched');
  assert.deepEqual(permission.edit, { '/t/skills/**': 'deny' });
});

test('a scalar whole-config permission posture is skipped untouched', () => {
  const config = { permission: 'ask' };
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.deepEqual(result, { changed: false, skipped: ['permission'] });
  assert.equal(config.permission, 'ask', 'converting the string form would revert every other permission to defaults');
});

test('a scalar-shaped section is skipped while its sibling still gets its globs', () => {
  const config = { permission: { external_directory: 'allow' } };
  const result = applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.deepEqual(result.skipped, ['external_directory']);
  assert.equal(result.changed, true);
  const permission = config.permission as Record<string, unknown>;
  assert.equal(permission.external_directory, 'allow', 'the scalar shape is the user’s — untouched');
  assert.deepEqual(permission.edit, { '/t/skills/**': 'deny' });
});

test('appended keys win under last-matching-rule semantics over an earlier broader pattern', () => {
  const config = { permission: { external_directory: { '~/.config/opencode/**': 'ask' } } };
  applySkillTreePermissionSeam(config, ['/x/huaweicloud-plugins/skills/**']);
  const section = (config.permission as Record<string, Record<string, string>>).external_directory;
  assert.deepEqual(Object.keys(section), ['~/.config/opencode/**', '/x/huaweicloud-plugins/skills/**']);
  assert.equal(section['/x/huaweicloud-plugins/skills/**'], 'allow');
});

test('removeSkillTreePermissionSeam deletes only value-exact matches and prunes seam-emptied sections', () => {
  const config = {
    permission: {
      external_directory: {
        '/t/skills/**': 'allow',
        '/user/path/**': 'allow',
      },
      edit: {
        '/t/skills/**': 'allow',
      },
    },
  };
  const changed = removeSkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(changed, true);
  const permission = config.permission as Record<string, Record<string, string>>;
  assert.deepEqual(permission.external_directory, { '/user/path/**': 'allow' }, 'other-glob rules survive');
  assert.deepEqual(permission.edit, { '/t/skills/**': 'allow' }, 'a user-modified value on a devkit glob survives');
});

test('the full write/remove cycle restores the pre-seam content', () => {
  const original = { permission: { external_directory: { '/user/path/**': 'ask' } } };
  const config = structuredClone(original);
  applySkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(removeSkillTreePermissionSeam(config, ['/t/skills/**']), true);
  assert.deepEqual(config, original);
});

test('the accepted edge: a user-authored same-shape rule predating the seam is removed with it', () => {
  const config = { permission: { external_directory: { '/t/skills/**': 'allow' } } };
  const changed = removeSkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(changed, true);
  assert.equal('permission' in config, false, 'the seam emptied the section and the top-level object');
});

test('a pre-existing empty section is left alone (no phantom change)', () => {
  const config = { permission: { external_directory: {} } };
  const changed = removeSkillTreePermissionSeam(config, ['/t/skills/**']);
  assert.equal(changed, false);
  assert.deepEqual(config.permission, { external_directory: {} });
});

test('opencodeSeamVersionSupported pins the measured floor, 2.x, and the unknown polarity', () => {
  assert.equal(opencodeSeamVersionSupported('1.19.0'), true);
  assert.equal(opencodeSeamVersionSupported('v1.19.1'), true);
  assert.equal(opencodeSeamVersionSupported('1.18.9'), false, 'below the measured floor');
  assert.equal(opencodeSeamVersionSupported('2.0.0'), true, 'an announced major must not fall below the floor');
  assert.equal(opencodeSeamVersionSupported('1.19'), false, 'unparsable per the anchored shape');
  assert.equal(opencodeSeamVersionSupported('opencode 1.19.0'), false, 'the probe must extract, not pass raw output');
  assert.equal(opencodeSeamVersionSupported(null), false, 'absent/unparsable polarity is skip');
});

// ── Part B: the seam through the real installer ──
// bin/setup.cjs with a throwaway home and the deterministic gate override
// (HUAWEICLOUD_OPENCODE_PERMISSION_SEAM), following the setup-packs
// precedent: same env hardening, same 240s bound (cold-cache installs
// fetch undici from the registry into the fake HOME's npm cache).

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const REQUIRED_CORE_SKILLS = [
  'huaweicloud-api-and-sdk',
  'huaweicloud-capability-discovery',
  'huaweicloud-cli-and-auth',
  'huaweicloud-core',
  'huaweicloud-safety',
  'huaweicloud-troubleshooting',
] as const;

function makeEnv(home: string, seam: 'on' | 'off'): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    // Fail the installer's own update check instantly against a closed port.
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9',
    // Deterministic gate: no dependence on whether opencode is on PATH.
    HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: seam,
    ...npmCacheEnv(),
  };
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HUAWEICLOUD_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'DEVKIT_PACKS',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(home: string, args: string[], seam: 'on' | 'off' = 'on') {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd: root,
    env: makeEnv(home, seam),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function opencodeConfigPath(home: string) {
  return join(home, '.config', 'opencode', 'opencode.json');
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(opencodeConfigPath(home), 'utf8')) as Record<string, unknown>;
}

function permissionSections(home: string) {
  const permission = (readConfig(home).permission ?? {}) as Record<string, Record<string, string>>;
  return {
    external: permission.external_directory ?? {},
    edit: permission.edit ?? {},
  };
}

function expectedGlobs(home: string): string[] {
  const pluginGlob = `${join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills').replace(/\\/g, '/')}/**`;
  const nativeRoot = join(home, '.config', 'opencode', 'skills').replace(/\\/g, '/');
  return [pluginGlob, ...REQUIRED_CORE_SKILLS.map((name) => `${nativeRoot}/${name}/**`)];
}

function expectedPayloadGlob(home: string): string {
  return `${join(home, '.config', 'opencode', 'huaweicloud-plugins').replace(/\\/g, '/')}/**`;
}

test('install writes the full seam (plugin tree + six native per-skill globs) and stays idempotent', () => {
  const home = fixtureDir('devkit-seam-fresh-');
  const first = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const globs = expectedGlobs(home);
  const payloadGlob = expectedPayloadGlob(home);
  const sections = permissionSections(home);
  for (const glob of globs) {
    assert.equal(sections.external[glob], 'allow', `external_directory allow missing for ${glob}`);
    assert.equal(sections.edit[glob], 'deny', `edit deny missing for ${glob}`);
  }
  // The payload root is the seam's edit-only class: the edit deny is written
  // and the external allow deliberately is not (extending it would make the
  // classifier a no-prompt bash write target).
  assert.equal(sections.edit[payloadGlob], 'deny', 'the payload-root edit deny is written');
  assert.equal(sections.external[payloadGlob], undefined, 'the external allow never covers the payload root');
  assert.equal(Object.keys(sections.external).length, globs.length, 'no extra external_directory rules');
  assert.ok(readConfig(home).mcp, 'the mcp entry is written alongside the seam');

  const second = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const after = permissionSections(home);
  assert.equal(Object.keys(after.external).length, globs.length, 're-install must not duplicate keys');
  assert.equal(
    Object.keys(after.edit).length,
    globs.length + 1,
    're-install must not duplicate keys (skills + payload)',
  );
});

test('a pre-payload-glob install (skills keys present, payload key absent) is healed by re-install', () => {
  // The real-world heal for this seam extension: every install made before
  // the payload-root edit deny existed carries the skills keys but not the
  // payload key. Re-install adds exactly the missing payload edit key and
  // never the external allow.
  const home = fixtureDir('devkit-seam-payload-heal-');
  const first = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const payloadGlob = expectedPayloadGlob(home);
  const configPath = opencodeConfigPath(home);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    Record<string, Record<string, string>>
  >;
  delete config.permission.edit[payloadGlob];
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const heal = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(heal.status, 0, heal.stderr || heal.stdout);
  const sections = permissionSections(home);
  assert.equal(sections.edit[payloadGlob], 'deny', 're-install restores the payload edit deny');
  assert.equal(sections.external[payloadGlob], undefined, 'the heal never adds the external allow');
});

test('a pre-seam install (unchanged mcp entry, no permission section) is healed by re-install', () => {
  // The C1 regression shape: the dominant update path returns early on an
  // unchanged mcp entry, and the seam must ride the same write anyway —
  // every install made before this seam existed is exactly this config.
  // The seed is the CANONICAL entry the current installer writes
  // (dist/mcp-server.js + the default timeout), so mergeCommandStyle
  // reports changed=false and applyPacksToEntry reports false — only
  // permChanged can carry the write. Seeding a drifted entry (src/ path,
  // missing timeout) would let the mcp rewrite itself trigger the write
  // and the regression would stay green.
  const home = fixtureDir('devkit-seam-heal-');
  const configDir = join(home, '.config', 'opencode');
  const distDir = join(configDir, 'huaweicloud-plugins', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'mcp-server.js'), '// seeded\n');
  const mcpPath = join(distDir, 'mcp-server.js').replace(/\\/g, '/');
  writeFileSync(
    opencodeConfigPath(home),
    JSON.stringify(
      {
        mcp: {
          'huaweicloud-devkit': {
            type: 'local',
            command: ['node', mcpPath],
            enabled: true,
            timeout: 300000,
          },
        },
      },
      null,
      2,
    ),
  );
  const res = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const sections = permissionSections(home);
  for (const glob of expectedGlobs(home)) {
    assert.equal(sections.external[glob], 'allow', `heal missed ${glob}`);
    assert.equal(sections.edit[glob], 'deny', `heal missed ${glob}`);
  }
  // The mcp entry itself must be untouched by the heal write — the seam
  // was the only change source, proving the early-return path was taken
  // and the seam still landed.
  assert.match(
    res.stdout,
    /OpenCode MCP config merged \(user fields preserved\)/,
    'the unchanged-mcp path executed (not the fresh-entry path)',
  );
});

test('the seam gate override off writes no permission section', () => {
  const home = fixtureDir('devkit-seam-off-');
  const res = runCli(home, ['install', '--target', 'opencode'], 'off');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.ok(readConfig(home).mcp, 'the mcp entry is still written');
  assert.equal('permission' in readConfig(home), false, 'the gate-off install writes no permission rules');
});

test('a scalar whole-config permission posture survives install untouched', () => {
  const home = fixtureDir('devkit-seam-scalar-');
  const configDir = join(home, '.config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(opencodeConfigPath(home), JSON.stringify({ permission: 'ask', mcp: {} }, null, 2));
  const res = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(readConfig(home).permission, 'ask', 'the user’s global posture is never converted');
});

test('uninstall removes the seam, keeps user rules, and keeps a user-modified value on a devkit glob', () => {
  const home = fixtureDir('devkit-seam-uninstall-');
  const install = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  // Simulate the user's own edits after install: a rule on another path,
  // and a modified value on one devkit glob.
  const config = readConfig(home);
  const permission = config.permission as Record<string, Record<string, string>>;
  permission.external_directory['/user/other/**'] = 'ask';
  permission.edit[expectedGlobs(home)[0]!] = 'allow';
  writeFileSync(opencodeConfigPath(home), JSON.stringify(config, null, 2));

  const uninstall = runCli(home, ['uninstall', '--target', 'opencode']);
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  const after = permissionSections(home);
  assert.deepEqual(after.external, { '/user/other/**': 'ask' }, 'user rules survive, devkit globs are gone');
  assert.deepEqual(
    after.edit,
    { [expectedGlobs(home)[0]!]: 'allow' },
    'the user-modified value on a devkit glob survives the value-exact delete',
  );
  assert.equal('mcp' in readConfig(home), false, 'the mcp entry is cleaned as before');
});

test('the packs command rewrite preserves the permission section', () => {
  const home = fixtureDir('devkit-seam-packs-');
  const install = runCli(home, ['install', '--target', 'opencode']);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  // packs enable is a no-op on the unset (full) surface; disable drives the
  // real config rewrite — the exact path that must not drop the seam.
  const packs = runCli(home, ['packs', 'disable', 'voucher', '--target', 'opencode']);
  assert.equal(packs.status, 0, packs.stderr || packs.stdout);
  const sections = permissionSections(home);
  for (const glob of expectedGlobs(home)) {
    assert.equal(sections.external[glob], 'allow', `packs rewrite dropped ${glob}`);
    assert.equal(sections.edit[glob], 'deny', `packs rewrite dropped ${glob}`);
  }
  const entry = (readConfig(home).mcp as Record<string, Record<string, unknown>>)['huaweicloud-devkit'];
  const env = (entry.environment ?? {}) as Record<string, string>;
  assert.ok(env.DEVKIT_PACKS?.startsWith('core,'), 'the packs write itself landed');
  assert.ok(!env.DEVKIT_PACKS?.includes('voucher'), 'voucher is the disabled id');
  assert.ok(existsSync(opencodeConfigPath(home)));
});
