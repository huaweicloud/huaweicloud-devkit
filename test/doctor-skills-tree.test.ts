import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const distSetup = join(root, 'plugins', 'huaweicloud-core', 'dist', 'setup-cli.js');
const realTree = join(root, 'plugins', 'huaweicloud-core', 'skills');

const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

// Doctor needs the built CLI and the generated tree (its roster of record is
// the shipped manifest); one guided precondition instead of raw failures.
assert.ok(existsSync(distSetup) && existsSync(realTree), 'dist/ and skills/ missing — run: npm run build');

// A minimal fake-HOME env for doctor. Payload candidates resolve through
// os.homedir(), which reads USERPROFILE on Windows and HOME on POSIX — both
// must be redirected or the negative tests pass vacuously on Windows (the
// payload lands where doctor never looks). HERMES_HOME is the
// highest-priority override for the hermes payload dir and must be cleared
// or an ambient value leaks a real install into the candidates.
function doctorEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    // keep OfficeAce detection hermetic in automated environments (#654)
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...extra,
  };
  delete env.ATOMCODE_HOME;
  delete env.HUAWEICLOUD_HOME;
  delete env.OFFICE_CLAW_CONFIG_ROOT;
  delete env.HERMES_HOME;
  // XDG_CONFIG_HOME redirects the opencode config root (xdgConfigHome);
  // CODEX_HOME keys the uninstaller's codex cache cleanup. Ambient values
  // would leak doctor's fresh-install probes into real state (a test that
  // needs XDG_CONFIG_HOME set uses the DSH_HOME guard pattern).
  if (!('XDG_CONFIG_HOME' in extra)) delete env.XDG_CONFIG_HOME;
  delete env.CODEX_HOME;
  if (!('DSH_HOME' in extra)) delete env.DSH_HOME;
  return env;
}

function runDoctor(home: string, extra: Record<string, string> = {}): string {
  const run = spawnSync(process.execPath, [setupCli, 'doctor'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    timeout: 60_000,
  });
  // exit 1 is the healthy "some check failed" path (a fake HOME has no
  // installs); only a crash or timeout aborts the test.
  assert.ok(run.status === 0 || run.status === 1, `doctor crashed: ${run.stderr}`);
  // Strip ANSI so [PASS]/[FAIL] assertions see the plain markers (check()
  // wraps them in color escapes). The escape is built from fromCharCode —
  // same idiom as dep-provision's stripAnsi — because eslint's
  // no-control-regex (rightly) flags control characters in regex literals.
  return (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

// A real install into the fake home, so the native freshness checks see an
// installed payload with receipt-managed native copies.
function runInstall(home: string, extra: Record<string, string> = {}): void {
  const run = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    // Install-bearing: cold fake-HOME undici fetch needs the 240s class.
    timeout: 240_000,
  });
  assert.ok(run.status === 0, `install failed: ${run.stderr}\n${run.stdout}`);
}

// An installed payload's skills/ dir, as copyServerPayload would have laid
// it out: one directory per skill, each with a SKILL.md.
function writePayloadTree(payloadSkills: string, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(payloadSkills, name), { recursive: true });
    writeFileSync(join(payloadSkills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}

// The DSH package-root candidate: serverSkillDirNames() appends 'skills' to
// its argument, so the pushed candidate must be PLUGIN_ROOT itself. The
// pre-fix shape pushed PLUGIN_ROOT/skills and probed PLUGIN_ROOT/skills/skills
// — the fallback was inert and a DSH-only healthy install false-FAILED.
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
test('doctor: healthy install raises no native core-skill warnings', () => {
  const home = fixtureDir('hwc-doctor-native-ok-');
  runInstall(home);
  const stdout = runDoctor(home);
  assert.ok(!stdout.includes('Native core skills'), `unexpected native warning:\n${stdout}`);
  assert.ok(!stdout.includes('stale native skill cop'), `unexpected stale warning:\n${stdout}`);
});

// Divergence and missing are the two drift shapes the freshness check
// exists for: an edited native copy and a deleted one both warn with the
// per-skill name and the remediation.
test('doctor: divergent and missing native core copies warn', () => {
  const home = fixtureDir('hwc-doctor-native-drift-');
  runInstall(home);
  const nativeDir = join(home, '.config', 'opencode', 'skills');
  writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), 'stale\n', 'utf8');
  rmSync(join(nativeDir, 'huaweicloud-safety'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(
    stdout.includes('huaweicloud-core diverges from the installed payload'),
    `missing divergence warn:\n${stdout}`,
  );
  assert.ok(stdout.includes('huaweicloud-safety missing'), `missing-copy warn:\n${stdout}`);
});

// Receipt-managed native copies with no installed server behind them are
// orphaned disclosure: content pointing at MCP tools nothing serves.
test('doctor: native copies without an installed server warn as orphans', () => {
  const home = fixtureDir('hwc-doctor-native-orphan-');
  runInstall(home);
  rmSync(join(home, '.config', 'opencode', 'huaweicloud-plugins'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('without an installed MCP server'), `missing orphan warn:\n${stdout}`);
});

// officeace's dir is never a sync target: owned names there are foreign no
// matter what receipt a hand-crafted one claims, and warn as stale.
test('doctor: owned names in officeace native dir warn as stale', () => {
  const home = fixtureDir('hwc-doctor-native-officeace-');
  runInstall(home);
  const officeaceDir = join(home, '.office-claw', 'skills');
  mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
  writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
  writeFileSync(join(officeaceDir, '.huaweicloud-devkit-native.json'), '{"names":["huawei-ecs"]}');
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('stale native skill cop'), `missing officeace stale warn:\n${stdout}`);
});

// --- Native core-skill disclosure checks (layout, skew, robustness) ---

// The DSH marketplace layout, as the postinstall really leaves it: no
// plugin dir, no CLI-written profile patch (the bundled patch DSH consumes
// never carries the CLI-managed block's markers), a receipt recording the
// package-root layout, and native copies the profile's postinstall placed.
// The staged package's core skill differs by one byte from the doctor CLI's
// own tree — the discriminating case: a comparator that reads the doctor's
// tree instead of the recorded package root would report divergence on a
// healthy install. Tampering a native copy must flip to the divergence
// warning with the marketplace remediation (update --target would refuse:
// there is no plugin dir to update).
test('doctor: DSH marketplace layout compares against the profile package, not the doctor CLI', () => {
  const home = fixtureDir('hwc-doctor-native-dsh-');
  const dshHome = fixtureDir('hwc-doctor-native-dshroot-');
  const pkg = fixtureDir('hwc-doctor-native-dshpkg-');
  const pkgSkills = join(pkg, 'plugins', 'huaweicloud-core', 'skills');
  cpSync(realTree, pkgSkills, { recursive: true });
  const doctored = `${readFileSync(join(pkgSkills, 'huaweicloud-core', 'SKILL.md'), 'utf8')}\n<!-- one byte older -->\n`;
  writeFileSync(join(pkgSkills, 'huaweicloud-core', 'SKILL.md'), doctored, 'utf8');
  const core = parseCoreSkillNames(readFileSync(join(pkgSkills, '.manifest.json'), 'utf8'));
  assert.ok(core, 'staged manifest core roster must parse');
  const nativeDir = join(dshHome, 'skills');
  for (const name of core) {
    cpSync(join(pkgSkills, name), join(nativeDir, name), { recursive: true });
  }
  writeFileSync(
    join(nativeDir, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify(
      { names: [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), layout: 'package-root', packageRoot: pkg },
      null,
      2,
    )}\n`,
  );
  const healthy = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(
    !healthy.includes('Native core skills') && !healthy.includes('stale native skill cop'),
    `a healthy marketplace install must raise no native warnings, got:\n${healthy}`,
  );

  writeFileSync(join(nativeDir, 'huaweicloud-safety', 'SKILL.md'), 'tampered\n', 'utf8');
  const tampered = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(
    tampered.includes('huaweicloud-safety diverges from the installed payload'),
    `missing divergence warn:\n${tampered}`,
  );
  assert.ok(
    tampered.includes('upgrade the huaweicloud-devkit package inside the DSH profile'),
    `the marketplace remediation must name the package upgrade, not update --target:\n${tampered}`,
  );
});

// Version skew: the payload's own manifest is the freshness roster, so a
// doctor CLI whose manifest knows a core skill the installed payload never
// claimed does not demand it per-agent. The native copy is removed too —
// with the copy present, a regressed roster (the CLI's own) would also stay
// silent, and the test would pass with the fix deleted.
test('doctor: freshness roster comes from the payload manifest, not the CLI', () => {
  const home = fixtureDir('hwc-doctor-native-skew-');
  runInstall(home);
  const payloadManifest = JSON.parse(
    readFileSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills', '.manifest.json'), 'utf8'),
  );
  delete payloadManifest.packOf['huaweicloud-safety'];
  writeFileSync(
    join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills', '.manifest.json'),
    JSON.stringify(payloadManifest, null, 2),
  );
  rmSync(join(home, '.config', 'opencode', 'skills', 'huaweicloud-safety'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(!stdout.includes('Native core skills'), `unexpected native warning under skew:\n${stdout}`);
});

// Receipts whose maintainer this run cannot resolve — layout-less (written
// before the layout field existed) or a marketplace receipt whose root was
// dropped as malformed — get the hedge: the marketplace is named as a
// possible owner, scoped to the DSH row (the postinstall only ever writes
// ~/.dsh/skills; for every other row a layout-less receipt can only be a
// plugin-dir install and the precise remediation is correct). A corrupt
// receipt suppresses the orphan branch entirely — the corrupt-receipt
// warning carries the remediation, and for the DSH dir that warning names
// both remediations.
test('doctor: unresolved-layout receipts hedge on the dsh row only; corrupt receipts stay silent', () => {
  const core = parseCoreSkillNames(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(core, 'manifest core roster must parse');
  const sortedNames = [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const mkNative = (fixture: string, receiptBody: string): string => {
    const h = fixtureDir(fixture);
    const dshHome = fixtureDir(`${fixture}-root-`);
    const nativeDir = join(dshHome, 'skills');
    for (const name of core) {
      cpSync(join(realTree, name), join(nativeDir, name), { recursive: true });
    }
    writeFileSync(join(nativeDir, '.huaweicloud-devkit-native.json'), receiptBody);
    return runDoctor(h, { DSH_HOME: dshHome });
  };

  const v1Out = mkNative('hwc-doctor-native-v1-', `${JSON.stringify({ names: sortedNames }, null, 2)}\n`);
  assert.ok(v1Out.includes('no resolvable layout'), `layout-less receipt must hedge:\n${v1Out}`);
  assert.ok(v1Out.includes('DSH profile'), `the hedge must name the marketplace owner:\n${v1Out}`);
  assert.ok(
    !v1Out.includes('present without an installed MCP server — re-run'),
    `the layout-converting remediation must not be the sole advice:\n${v1Out}`,
  );

  // A marketplace receipt whose packageRoot was dropped (relative here)
  // must hedge at least as strongly as the layout-less one.
  const rootlessOut = mkNative(
    'hwc-doctor-native-rootless-',
    JSON.stringify({ names: sortedNames, layout: 'package-root', packageRoot: 'relative/pkg' }),
  );
  assert.ok(rootlessOut.includes('no resolvable layout'), `rootless marketplace receipt must hedge:\n${rootlessOut}`);

  // A non-DSH row with a layout-less receipt: only the CLI ever wrote
  // there — the precise orphan message is correct, the DSH hedge is wrong.
  const home2 = fixtureDir('hwc-doctor-native-v1oc-');
  const ocNative = join(home2, '.config', 'opencode', 'skills');
  for (const name of core) {
    cpSync(join(realTree, name), join(ocNative, name), { recursive: true });
  }
  writeFileSync(
    join(ocNative, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify({ names: sortedNames }, null, 2)}\n`,
  );
  const ocOut = runDoctor(home2);
  assert.ok(
    ocOut.includes(
      'Native core skills (OpenCode) present without an installed MCP server — re-run: npx huaweicloud-devkit install --target opencode',
    ),
    `the non-DSH row keeps the precise remediation:\n${ocOut}`,
  );
  assert.ok(!ocOut.includes('DSH profile'), `the DSH hedge must not fire for an OpenCode dir:\n${ocOut}`);

  const corruptOut = mkNative('hwc-doctor-native-cx-', '{"names": [torn');
  assert.ok(corruptOut.includes('unreadable native receipt'), `corrupt warning expected:\n${corruptOut}`);
  assert.ok(
    corruptOut.includes("re-run the DSH profile's package install or npx huaweicloud-devkit install"),
    `the corrupt warning on the DSH dir must name both remediations:\n${corruptOut}`,
  );
  assert.ok(
    !corruptOut.includes('present without an installed MCP server'),
    `a corrupt receipt must not orphan a marketplace install it cannot see:\n${corruptOut}`,
  );
});

// A torn or shape-broken receipt is visible: doctor warns instead of
// silently demoting the dir to residue treatment. The boundary is the
// shared module's — both broken shapes classify as corrupt.
test('doctor: unreadable native receipts warn, torn and shape-broken alike', () => {
  const home = fixtureDir('hwc-doctor-native-corrupt-');
  runInstall(home);
  const receiptPath = join(home, '.config', 'opencode', 'skills', '.huaweicloud-devkit-native.json');
  for (const shape of ['{"names": [torn', '{"names": null}']) {
    writeFileSync(receiptPath, shape);
    const stdout = runDoctor(home);
    assert.ok(stdout.includes('unreadable native receipt'), `missing corrupt-receipt warn for ${shape}:\n${stdout}`);
  }
});

// An installed payload whose plugin dir has dist/ but no skills/ (the
// interrupted-copyServerPayload crash shape): the global skills-tree check
// is a some() across candidates, so a healthy target masks the broken one —
// the per-target freshness pass must name it instead of silently skipping.
test('doctor: an installed payload without a skills tree warns per target', () => {
  const home = fixtureDir('hwc-doctor-native-brokenpayload-');
  runInstall(home);
  const wbPlugins = join(home, '.workbuddy', 'huaweicloud-plugins');
  const wbNative = join(home, '.workbuddy', 'skills');
  mkdirSync(join(wbPlugins, 'dist'), { recursive: true });
  writeFileSync(join(wbPlugins, 'dist', 'mcp-server.js'), 'x', 'utf8');
  const core = parseCoreSkillNames(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(core, 'manifest core roster must parse');
  for (const name of core) {
    cpSync(join(realTree, name), join(wbNative, name), { recursive: true });
  }
  writeFileSync(
    join(wbNative, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify({ names: [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }, null, 2)}\n`,
  );
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('the installed payload has no skills tree'), `missing broken-payload warn:\n${stdout}`);
});

// A package without a skills tree: the skills-tree check FAILs and the
// native block warns — the diagnostic run must complete, not crash
// mid-stream at the core-roster read.
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
  assert.ok(run.status === 0 || run.status === 1, `doctor crashed: ${run.stderr}`);
  const stdout = (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  assert.ok(stdout.includes('[FAIL] Skills tree'), 'the skills-tree check must FAIL');
  assert.ok(stdout.includes('lacks usable core-pack info'), 'the native block must warn instead of aborting the run');
  assert.ok(!stdout.includes('skills tree missing at'), `the throw leaked into output:\n${stdout}`);
});
