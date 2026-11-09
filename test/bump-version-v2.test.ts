import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

const BUMP_SCRIPT = fileURLToPath(new URL('../scripts/bump-version.mjs', import.meta.url));

// bump-version.mjs derives its manifest/override root from its own location
// (import.meta.url), so the hermetic fixture copies the script into a scratch
// repo at runtime — a runtime copy is invisible to the jscpd scan. The git
// commands inside the script carry no cwd and inherit the spawned process's
// cwd, so every exec below runs with cwd set to the scratch repo.
function scratchRepo(manifestVersion: string, override: string | null) {
  const dir = fixtureDir('bump-version-v2-');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(BUMP_SCRIPT, join(dir, 'scripts', 'bump-version.mjs'));
  writeFileSync(join(dir, '.release-please-manifest.json'), `${JSON.stringify({ '.': manifestVersion }, null, 2)}\n`);
  if (override !== null) {
    writeFileSync(join(dir, '.version-override'), override);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', 'seed.txt');
  git('commit', '-m', 'seed');
  return { dir, git };
}

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), `${file}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-m', file], { cwd: dir });
}

function bump(dir: string, branch: string): string {
  return execFileSync('node', [join('scripts', 'bump-version.mjs'), branch], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

test('v2 arm: first prerelease comes from the committed .version-override, not the latest stable tag', () => {
  const { dir, git } = scratchRepo('1.1.7', '2.0.0');
  git('tag', 'v1.1.7');
  commit(dir, 'work.txt');
  git('tag', 'v1.1.9');
  assert.equal(bump(dir, 'v2'), '2.0.0-next.0');
});

test('v2 arm: counter increments past the highest v2.0.0-next.* tag', () => {
  const { dir, git } = scratchRepo('1.1.7', '2.0.0');
  git('tag', 'v1.1.7');
  commit(dir, 'work.txt');
  git('tag', 'v2.0.0-next.0');
  assert.equal(bump(dir, 'v2'), '2.0.0-next.1');
  git('tag', 'v2.0.0-next.3');
  git('tag', 'v2.0.0-next.1');
  assert.equal(bump(dir, 'v2'), '2.0.0-next.4');
});

test('v2 arm: without .version-override the base comes from the branch name, not the stable scan', () => {
  const { dir, git } = scratchRepo('1.1.7', null);
  git('tag', 'v1.1.7');
  commit(dir, 'work.txt');
  git('tag', 'v1.1.9');
  assert.equal(bump(dir, 'v2'), '2.0.0-next.0');
});

test('v2 arm: an explicit .version-override beats the branch-name base', () => {
  const { dir, git } = scratchRepo('1.1.7', '3.0.0');
  git('tag', 'v1.1.7');
  commit(dir, 'work.txt');
  assert.equal(bump(dir, 'v2'), '3.0.0-next.0');
});

test('bump guard: manifest version already tagged at tip silences the script', () => {
  const { dir, git } = scratchRepo('1.1.7', '2.0.0');
  git('tag', 'v1.1.7');
  assert.equal(bump(dir, 'v2'), '');
});

test('bump guard: manifest version without a tag exits silently — the manifest must never name an untagged version', () => {
  const { dir, git } = scratchRepo('1.1.7', '2.0.0');
  git('tag', 'v1.1.9');
  commit(dir, 'work.txt');
  assert.equal(bump(dir, 'v2'), '');
});
