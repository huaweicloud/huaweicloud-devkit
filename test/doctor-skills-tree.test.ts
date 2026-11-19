import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  allSkills,
  doctorEnv,
  doctorRunText,
  runDoctor,
  runInstall,
  root,
  writePayloadTree,
} from './doctor-helpers.ts';

test('doctor: DSH layout resolves the skills tree from the package root', () => {
  const home = fixtureDir('hwc-doctor-dsh-home-');
  const dshHome = fixtureDir('hwc-doctor-dsh-');
  const profileDir = join(dshHome, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  // dshPatchConfigured() matches on these markers.
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      'id: huaweicloud-devkit',
      "require: '@deepseek-ai/dsh-mcp-client'",
      'serverName: huaweicloud',
      'id: huaweicloud-hook',
      '',
    ].join('\n'),
    'utf8',
  );
  const stdout = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(stdout.includes('[PASS] Skills tree'), `expected the DSH candidate to pass, got:\n${stdout}`);
});

// The doctor probe must read the opencode config through the same
// xdgConfigHome() resolver the installer wrote it with — under a
// non-default absolute XDG_CONFIG_HOME, install and doctor each resolving
// their own root would pass vacuously everywhere else and split only here
// (install green, doctor "MCP not configured"). The direction assertions
// (config under the XDG root, legacy root untouched) keep the test
// non-vacuous against a broken env plumb.
test('doctor: opencode probe follows an absolute XDG_CONFIG_HOME', () => {
  const home = fixtureDir('hwc-doctor-xdg-home-');
  const xdgRoot = join(home, 'xdg-config');
  runInstall(home, { XDG_CONFIG_HOME: xdgRoot });
  assert.ok(
    existsSync(join(xdgRoot, 'opencode', 'opencode.json')),
    'install must write the config under the XDG root (env plumb took effect)',
  );
  assert.ok(!existsSync(join(home, '.config', 'opencode')), 'the legacy root must stay untouched');
  const stdout = runDoctor(home, { XDG_CONFIG_HOME: xdgRoot });
  // check() prints the detail only on FAIL, so the candidate name is not
  // visible on a pass — but the direction assertions above already prove
  // the config exists ONLY under the XDG root, so a PASS here means doctor
  // resolved it through the shared XDG resolver (a split would read the
  // empty legacy root and print [FAIL] MCP configured).
  assert.ok(
    stdout.includes('[PASS] MCP configured'),
    `doctor must probe the config through the shared XDG resolver, got:\n${stdout}`,
  );
});

// Equality, not subset: an installed payload carrying an unclaimed extra dir
// must FAIL — the boot guard (verifySkillTree) rejects extras, so doctor must
// never pass a tree the server would refuse to start.
test('doctor: a payload with an extra skill dir fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-extra-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, [...allSkills, 'huawei-not-claimed']);
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the extra dir to fail, got:\n${stdout}`);
});

test('doctor: a payload missing a claimed skill fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-missing-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, allSkills.slice(0, -1));
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the missing skill to fail, got:\n${stdout}`);
});

// A hollow claimed dir (name present, SKILL.md absent — the interrupted-copy
// / AV-quarantine shape) is a missing skill to the boot guard's listing, so
// doctor must reject it too: doctor's listing is the same shared predicate.
test('doctor: a payload with a hollow claimed dir fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-hollow-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, allSkills);
  rmSync(join(payloadSkills, 'huawei-ecs', 'SKILL.md'));
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the hollow dir to fail, got:\n${stdout}`);
});

// A symlinked stray dir with a SKILL.md is listable by the boot guard (which
// counts symlinks) and would be served ungated — doctor must see it too.
test(
  'doctor: a payload with a symlinked stray skill dir fails the skills tree check',
  { skip: process.platform === 'win32' },
  () => {
    const home = fixtureDir('hwc-doctor-link-');
    const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
    const external = join(home, 'external', 'huawei-not-claimed');
    mkdirSync(payloadSkills, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'SKILL.md'), '---\nname: huawei-not-claimed\n---\n', 'utf8');
    writePayloadTree(payloadSkills, allSkills);
    symlinkSync(external, join(payloadSkills, 'huawei-not-claimed'));
    const stdout = runDoctor(home);
    assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the symlinked stray to fail, got:\n${stdout}`);
  },
);

// --- Native core-skill disclosure checks ---

// A healthy install carries receipt-managed native copies equal to its
// payload: no native warning may appear.

test('doctor: missing skills tree fails the check without aborting the run', () => {
  const stage = fixtureDir('hwc-doctor-notree-pkg-');
  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(join(root, 'bin', 'setup.cjs'), join(stage, 'bin', 'setup.cjs'));
  cpSync(join(root, 'package.json'), join(stage, 'package.json'));
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(stage, 'plugins', 'huaweicloud-core', 'dist'), {
    recursive: true,
  });
  // safety/ is read at module load (redactSecrets), so the staged package
  // must carry it; skills/ is the one deliberately absent dir.
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(stage, 'plugins', 'huaweicloud-core', 'safety'), {
    recursive: true,
  });
  const home = fixtureDir('hwc-doctor-notree-home-');
  const run = spawnSync(process.execPath, [join(stage, 'bin', 'setup.cjs'), 'doctor'], {
    encoding: 'utf8',
    env: doctorEnv(home),
    timeout: 60_000,
  });
  const stdout = doctorRunText(run);
  assert.ok(stdout.includes('[FAIL] Skills tree'), 'the skills-tree check must FAIL');
  assert.ok(stdout.includes('lacks usable core-pack info'), 'the native block must warn instead of aborting the run');
  assert.ok(!stdout.includes('skills tree missing at'), `the throw leaked into output:\n${stdout}`);
});

// ── The skills-tree permission seam's doctor states ──
// The check is OpenCode-scoped and gate-dependent; HUAWEICLOUD_OPENCODE_PERMISSION_SEAM=on
// pins the gate so the states are deterministic regardless of the host's opencode.
// Four states pinned: ok (PASS), pure-missing (FAIL + reinstall remediation),
// mixed user-owned + missing (FAIL reporting BOTH — one user-owned glob must never
// mask a healable gap, the masking shape the per-glob evaluation exists to kill),
// and scalar-shaped permission (SKIP with the manual pointer — the installer itself
// refuses that config, so a re-run-install remediation could never succeed).
test('doctor: seam check reports ok, pure-missing, mixed, and scalar states per its contract', () => {
  const home = fixtureDir('hwc-doctor-seam-');
  runInstall(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  const configPath = join(home, '.config', 'opencode', 'opencode.json');
  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  const okOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  assert.ok(okOut.includes('[PASS] Skills-tree permission seam'), `a complete seam must PASS, got:\n${okOut}`);

  const treeGlob = `${join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills').replace(/\\/g, '/')}/**`;
  const asMissing = readConfig();
  const missingPermission = asMissing.permission as Record<string, Record<string, string>>;
  delete missingPermission.edit[treeGlob];
  writeFileSync(configPath, JSON.stringify(asMissing, null, 2));
  const missingOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  assert.ok(
    missingOut.includes('[FAIL] Skills-tree permission seam') &&
      missingOut.includes('writes the missing seam rules'),
    `a deleted edit deny must FAIL with the reinstall remediation, got:\n${missingOut}`,
  );

  const asMixed = readConfig();
  const mixedPermission = asMixed.permission as Record<string, Record<string, string>>;
  const extKeys = Object.keys(mixedPermission.external_directory);
  const userGlob = extKeys.find((k) => k !== treeGlob)!;
  mixedPermission.external_directory[userGlob] = 'ask';
  const secondGlob = extKeys.find((k) => k !== treeGlob && k !== userGlob)!;
  delete mixedPermission.edit[secondGlob];
  writeFileSync(configPath, JSON.stringify(asMixed, null, 2));
  const mixedOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  assert.ok(
    /\d+ rule\(s\) missing/.test(mixedOut) && mixedOut.includes('1 user-owned glob(s) kept as-is'),
    `mixed state must report BOTH the healable gap and the kept glob, got:\n${mixedOut}`,
  );

  writeFileSync(configPath, JSON.stringify({ permission: 'ask', mcp: readConfig().mcp }, null, 2));
  const scalarOut = runDoctor(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  assert.ok(
    scalarOut.includes('[SKIP] Skills-tree permission seam') && scalarOut.includes('add the rules manually'),
    `a scalar permission posture must SKIP with the manual pointer (never a reinstall FAIL), got:\n${scalarOut}`,
  );
});
