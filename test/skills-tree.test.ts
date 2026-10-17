import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { verifySkillTree } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import {
  parseSkillManifest,
  parseSkillPackMap,
  parseCoreSkillNames,
} from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { run, writeSkillsTree } from '../scripts/sync-skills.mjs';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');
const realTree = join(pluginRoot, 'skills');

// The registry roster is the ownership truth verifySkillTree enforces.
const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

// The tree-reading tests below need the generated skills tree (a build
// artifact); one guided precondition instead of a raw ENOENT on a fresh
// checkout.
assert.ok(existsSync(realTree), 'generated skills tree missing — run: npm run build');

function makeTree(dir: string, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}

// A one-pack fixture source tree for driving check mode / regeneration
// against fixtures instead of the real ones.
function makePackSources(packs: string, skill: string): void {
  mkdirSync(join(packs, 'p', 'skills', skill), { recursive: true });
  writeFileSync(join(packs, 'p', 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`, 'utf8');
}

// Fail-loud is the changeset's load-bearing behavior: a tree that does not
// EQUAL the registry roster must refuse to boot. These exercise the guard
// through its injectable root, so no real tree is touched.
test('verifySkillTree accepts a tree equal to the registry roster', () => {
  const dir = fixtureDir('hwc-skills-ok-');
  makeTree(dir, allSkills);
  assert.doesNotThrow(() => verifySkillTree(dir));
});

test('verifySkillTree refuses a tree missing a claimed skill', () => {
  const dir = fixtureDir('hwc-skills-missing-');
  const [dropped, ...rest] = allSkills;
  makeTree(dir, rest);
  assert.throws(
    () => verifySkillTree(dir),
    (error: Error) => error.message.includes('missing') && error.message.includes(dropped!),
  );
});

test('verifySkillTree refuses an unclaimed skill directory (ungated-serve hole)', () => {
  const dir = fixtureDir('hwc-skills-extra-');
  makeTree(dir, [...allSkills, 'huawei-not-claimed']);
  assert.throws(
    () => verifySkillTree(dir),
    (error: Error) => error.message.includes('unclaimed') && error.message.includes('huawei-not-claimed'),
  );
});

// The stray-dir scan must use the same listing the boot guard uses. The
// clean-tree positive control comes from a fixture regeneration, so the
// manifest is byte-correct before the stray entries are added.
test(
  'run reports stray skill dirs the sources do not claim (dir and symlink)',
  { skip: process.platform === 'win32' },
  () => {
    const sources = fixtureDir('hwc-run-src-');
    makePackSources(sources, 's1');
    const treeParent = fixtureDir('hwc-run-tree-');
    const tree = join(treeParent, 'skills');
    writeSkillsTree({ packsDir: sources, outDir: tree });
    const clean = run({ packsDir: sources, outDir: tree });
    assert.deepEqual(clean.failures, []);

    mkdirSync(join(tree, 'stray-skill'), { recursive: true });
    writeFileSync(join(tree, 'stray-skill', 'SKILL.md'), '---\nname: stray-skill\n---\n', 'utf8');
    const external = join(treeParent, 'external', 'stray-link');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'SKILL.md'), '---\nname: stray-link\n---\n', 'utf8');
    symlinkSync(external, join(tree, 'stray-link'));

    const { failures } = run({ packsDir: sources, outDir: tree });
    assert.ok(
      failures.some((f) => f.includes('stray skill dir') && f.includes('stray-skill')),
      `expected the stray dir to fail, got: ${failures.join('; ')}`,
    );
    assert.ok(
      failures.some((f) => f.includes('stray skill dir') && f.includes('stray-link')),
      `expected the symlinked stray to fail, got: ${failures.join('; ')}`,
    );
  },
);

// Parity in the other direction: a dir without a SKILL.md is invisible to
// the boot guard's listing, so check mode must not flag it either.
test('run ignores a stray dir without SKILL.md (boot-guard parity)', () => {
  const sources = fixtureDir('hwc-run-src2-');
  makePackSources(sources, 's1');
  const tree = join(fixtureDir('hwc-run-tree2-'), 'skills');
  writeSkillsTree({ packsDir: sources, outDir: tree });
  mkdirSync(join(tree, 'empty-stray'), { recursive: true });
  const { failures } = run({ packsDir: sources, outDir: tree });
  assert.ok(
    failures.every((f) => !f.includes('empty-stray')),
    `an SKILL.md-less dir must not be flagged, got: ${failures.join('; ')}`,
  );
});

test('writeSkillsTree refuses an empty source root and leaves the real tree intact', () => {
  const empty = fixtureDir('hwc-skills-empty-');
  assert.throws(() => writeSkillsTree({ packsDir: empty }), /no pack skill sources found/);
  assert.ok(
    readdirSync(realTree, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length > 0,
    'the real generated tree must survive a refused regeneration',
  );
  assert.ok(existsSync(join(realTree, '.manifest.json')), 'the shipped manifest must survive a refused regeneration');
});
// A render failure after staging began must clean the staging dir (the live
// tree is still intact, so the staging copy is disposable). chmod is the
// portable-enough way to make a source read fail; it is a no-op on Windows
// and does not block reads for root, so both are skipped. The pre-created
// live tree at the target is the guard: a regression that removes the
// target before or during the render (instead of after it completes) would
// destroy it and fail the survival assertion.
test(
  'writeSkillsTree cleans up its staging dir when rendering fails mid-way',
  {
    skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  },
  () => {
    const sources = fixtureDir('hwc-skills-renderfail-');
    makePackSources(sources, 's1');
    const skillMd = join(sources, 'p', 'skills', 's1', 'SKILL.md');
    chmodSync(skillMd, 0o000);
    const treeParent = fixtureDir('hwc-skills-renderfail-tree-');
    const tree = join(treeParent, 'skills');
    mkdirSync(join(tree, 'old'), { recursive: true });
    writeFileSync(join(tree, 'old', 'SKILL.md'), '---\nname: old\n---\n', 'utf8');
    try {
      assert.throws(() => writeSkillsTree({ packsDir: sources, outDir: tree }), /(EACCES|permission)/i);
      assert.ok(
        !readdirSync(treeParent).some((name) => name.startsWith('skills.new-')),
        'no staging dir may remain after a failed render',
      );
      assert.ok(existsSync(join(tree, 'old', 'SKILL.md')), 'the live tree must survive a failed render');
    } finally {
      // restore readability so the exit-time fixture cleanup can unlink it
      chmodSync(skillMd, 0o644);
    }
  },
);

// The sweep: preserved recovery copies and crash leftovers are garbage, but
// an in-flight writer's staging dir never is. Freshness is the discriminator
// — backdate one dir past the threshold, keep another fresh, and assert the
// regeneration sweeps only the stale one.
test('writeSkillsTree sweeps stale staging dirs and spares fresh ones', () => {
  const sources = fixtureDir('hwc-sweep-src-');
  makePackSources(sources, 's1');
  const treeParent = fixtureDir('hwc-sweep-');
  const tree = join(treeParent, 'skills');
  const stale = join(treeParent, 'skills.new-stale');
  const fresh = join(treeParent, 'skills.new-fresh');
  mkdirSync(join(stale, 's1'), { recursive: true });
  writeFileSync(join(stale, 's1', 'SKILL.md'), '---\nname: s1\n---\n', 'utf8');
  mkdirSync(fresh, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, twoHoursAgo, twoHoursAgo);
  writeSkillsTree({ packsDir: sources, outDir: tree });
  assert.ok(!existsSync(stale), 'a staging dir untouched for over an hour must be swept');
  assert.ok(
    existsSync(fresh),
    'a fresh staging dir must be spared — a concurrent writer or a just-preserved recovery copy',
  );
  assert.ok(existsSync(join(tree, '.manifest.json')), 'the regeneration completed');
});
test('parseSkillManifest extracts, dedupes, and filters the roster', () => {
  assert.deepEqual(parseSkillManifest('{"skills":["b","a","b",42,"a"]}'), ['b', 'a']);
  assert.deepEqual(parseSkillManifest('{"skills":[]}'), []);
  assert.deepEqual(parseSkillManifest('{"generatedBy":"x"}'), []);
  assert.deepEqual(parseSkillManifest('not json'), []);
  assert.deepEqual(parseSkillManifest('{"skills":"nope"}'), []);
});

// The pack map is the fail-loud surface: absence and malformation must read
// as null (unusable), never as an empty-but-valid map, or the native-skill
// sync would silently derive an empty core set and invert its own cleanup.
test('parseSkillPackMap returns the map, or null when unusable', () => {
  assert.deepEqual(parseSkillPackMap('{"packOf":{"a":"core","b":"obs"}}'), { a: 'core', b: 'obs' });
  assert.deepEqual(parseSkillPackMap('{"packOf":{}}'), {});
  assert.equal(parseSkillPackMap('{"skills":["a"]}'), null, 'no packOf key');
  assert.equal(parseSkillPackMap('{"packOf":["a"]}'), null, 'array shape');
  assert.equal(parseSkillPackMap('{"packOf":{"a":1}}'), null, 'non-string pack id');
  assert.equal(parseSkillPackMap('not json'), null);
});

// The shared core-roster derivation: same fail-loud rule as the pack map.
test('parseCoreSkillNames returns the core set, or null when unusable', () => {
  const core = parseCoreSkillNames('{"packOf":{"a":"core","b":"obs","c":"core"}}');
  assert.ok(core);
  assert.deepEqual(
    [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ['a', 'c'],
  );
  assert.equal(parseCoreSkillNames('{"packOf":{"b":"obs"}}'), null, 'no core entries');
  assert.equal(parseCoreSkillNames('{"packOf":{}}'), null, 'empty map');
  assert.equal(parseCoreSkillNames('{"skills":["a"]}'), null, 'no packOf key');
  assert.equal(parseCoreSkillNames('not json'), null);
});

// The manifest's pack claims must agree with the registry: the installer
// derives the native core set from the manifest, so a drift between the two
// would disclose the wrong names natively.
test('manifest packOf agrees with the registry pack claims', () => {
  const packOf = parseSkillPackMap(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(packOf, 'generated manifest carries a usable packOf map');
  const claimed = new Set(PACKS.flatMap((pack) => pack.skills));
  for (const pack of PACKS) {
    for (const skill of pack.skills) {
      assert.equal(packOf[skill], pack.id, `${skill} claims pack ${pack.id} in the registry`);
    }
  }
  for (const name of Object.keys(packOf)) {
    assert.ok(claimed.has(name), `manifest packOf entry ${name} is claimed by no pack`);
  }
});
