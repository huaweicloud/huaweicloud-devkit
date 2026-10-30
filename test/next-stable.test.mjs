import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptSrc = fileURLToPath(new URL('../scripts/next-stable.mjs', import.meta.url));

function setupTagRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'next-stable-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(scriptSrc, join(dir, 'scripts', 'next-stable.mjs'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  writeFileSync(join(dir, 'init.txt'), '');
  execSync('git add .', { cwd: dir });
  execSync('git commit -qm init', { cwd: dir });
  return dir;
}

function runNextStable(dir) {
  return execSync('node scripts/next-stable.mjs', { cwd: dir, encoding: 'utf8' }).trim();
}

test('computeNextStable derives from the newest stable tag, skipping prerelease tags', () => {
  const dir = setupTagRepo();
  try {
    for (const tag of ['v1.0.0', 'v2.3.4', 'v0.0.9', 'v9.9.9-rc.1', 'release-legacy']) {
      execSync(`git tag ${tag}`, { cwd: dir });
    }
    assert.equal(runNextStable(dir), '2.3.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeNextStable honors .version-override when present', () => {
  const dir = setupTagRepo();
  try {
    execSync('git tag v1.0.0', { cwd: dir });
    writeFileSync(join(dir, '.version-override'), '9.9.9');
    assert.equal(runNextStable(dir), '9.9.9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeNextStable falls back to 0.0.1 when no stable tags exist', () => {
  const dir = setupTagRepo();
  try {
    execSync('git tag v1.2.3-beta.1', { cwd: dir });
    assert.equal(runNextStable(dir), '0.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
