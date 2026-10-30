import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, mock } from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

// Drive the two swap-failure interleavings of writeSkillsTree through one
// module mock: an rmSync that fails midway (the Windows locked-file shape)
// and a rename that fails after the live tree was removed. Both must
// PRESERVE the rendered staging dir — it is the only complete copy once the
// swap has begun — instead of deleting it. One mock, one dynamic import:
// node caches the module after the first import, so a second test with a
// different mock would silently reuse this one's bindings. The mock supplies
// every fs function sync-skills (and its skill-tree import) uses, real ones
// except the two under test — node:fs mocking is all-or-nothing per named
// export, and a `failOn` switch flips which one throws.
function makeOneSkillPack(sources: string, treeParent: string): { sources: string; treeParent: string; tree: string } {
  const skillDir = join(sources, 'p', 'skills', 's1');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: s1\n---\n', 'utf8');
  const tree = join(treeParent, 'skills');
  // A pre-existing "live tree" gives the swap something real to remove.
  mkdirSync(join(tree, 'old'), { recursive: true });
  writeFileSync(join(tree, 'old', 'SKILL.md'), '---\nname: old\n---\n', 'utf8');
  return { sources, treeParent, tree };
}

function stagingDirsOf(treeParent: string): string[] {
  return readdirSync(treeParent).filter((name) => name.startsWith('skills.new-'));
}

test(
  'writeSkillsTree preserves the rendered staging copy when the swap fails (rmSync midway, rename after removal)',
  { skip: typeof mock?.module !== 'function' },
  async (t) => {
    const rmFixture = makeOneSkillPack(fixtureDir('hwc-swap-rm-src-'), fixtureDir('hwc-swap-rm-'));
    const renameFixture = makeOneSkillPack(fixtureDir('hwc-swap-rename-src-'), fixtureDir('hwc-swap-rename-'));
    const actual = await import('node:fs');
    const realRmSync = actual.rmSync;
    const realRenameSync = actual.renameSync;
    let failOn: 'rm' | 'rename' = 'rm';
    // namedExports, not the newer options.exports: the repo's Node 22.19
    // floor predates options.exports (Node 24 already deprecation-warns
    // namedExports) — migrate when the floor moves past the version where
    // exports exists.
    t.mock.module('node:fs', {
      namedExports: {
        existsSync: actual.existsSync,
        mkdirSync: actual.mkdirSync,
        mkdtempSync: actual.mkdtempSync,
        readFileSync: actual.readFileSync,
        readdirSync: actual.readdirSync,
        statSync: actual.statSync,
        writeFileSync: actual.writeFileSync,
        rmSync: (path: Parameters<typeof realRmSync>[0], options: Parameters<typeof realRmSync>[1]) => {
          if (failOn === 'rm' && String(path) === rmFixture.tree) {
            // Delete one child for real before throwing, so the fixture
            // models an rmSync failing midway over a partially deleted tree
            // (the Windows locked-file shape), not merely one refusing to
            // start — the preserve guarantee is what is under test, and it
            // must hold either way.
            realRmSync(join(rmFixture.tree, 'old'), { recursive: true, force: true });
            throw new Error('mock EBUSY on the live tree');
          }
          return realRmSync(path, options);
        },
        renameSync: (from: Parameters<typeof realRenameSync>[0], to: Parameters<typeof realRenameSync>[1]) => {
          if (failOn === 'rename') throw new Error('mock EPERM on rename');
          return realRenameSync(from, to);
        },
      },
    });
    const { writeSkillsTree } = await import('../scripts/sync-skills.mjs');

    // Interleaving 1: rmSync throws midway — the live tree is damaged, the
    // staging copy must survive.
    assert.throws(
      () => writeSkillsTree({ packsDir: rmFixture.sources, outDir: rmFixture.tree }),
      /mock EBUSY on the live tree/,
    );
    let preserved = stagingDirsOf(rmFixture.treeParent);
    assert.equal(preserved.length, 1, `expected exactly one preserved staging dir, got ${preserved.join(', ')}`);
    let manifestPath = join(rmFixture.treeParent, preserved[0]!, '.manifest.json');
    assert.ok(existsSync(manifestPath), 'the preserved copy carries the manifest');
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).skills[0], 's1');

    // Interleaving 2: rmSync succeeds, rename fails — the live tree is gone,
    // the staging copy is the only recovery path.
    failOn = 'rename';
    assert.throws(
      () => writeSkillsTree({ packsDir: renameFixture.sources, outDir: renameFixture.tree }),
      /mock EPERM on rename/,
    );
    preserved = stagingDirsOf(renameFixture.treeParent);
    assert.equal(preserved.length, 1, `expected exactly one preserved staging dir, got ${preserved.join(', ')}`);
    manifestPath = join(renameFixture.treeParent, preserved[0]!, '.manifest.json');
    assert.ok(existsSync(manifestPath), 'the preserved copy carries the manifest');
    assert.ok(!existsSync(renameFixture.tree), 'the removed live tree is gone; the staging copy is the recovery path');
  },
);
