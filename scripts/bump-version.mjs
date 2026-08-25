import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const branch = process.argv[2];

const manifestPath = join(root, '.release-please-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const currentVersion = manifest['.'] || '0.0.0';

function hasTag(version) {
  try {
    execSync(`git rev-parse "v${version}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasTags = execSync('git tag -l "v*"', { encoding: 'utf8' }).trim() !== '';
if (hasTags) {
  const manifestHasTag = hasTag(currentVersion);
  if (!manifestHasTag) {
    process.exit(0);
  }

  const tagCommit = execSync(`git rev-list -n 1 "v${currentVersion}"`, { encoding: 'utf8' }).trim();
  const tip = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  if (tagCommit === tip) {
    process.exit(0);
  }

  const newCommits = execSync(`git rev-list "v${currentVersion}"..HEAD --no-merges`, { encoding: 'utf8' }).trim();
  if (!newCommits) {
    process.exit(0);
  }
}

let nextVersion;
if (branch === 'dev') {
  const match = currentVersion.match(/^(\d+\.\d+\.\d+)-(next)\.(\d+)$/);
  if (match) {
    const [, base, label, counter] = match;
    nextVersion = `${base}-${label}.${parseInt(counter, 10) + 1}`;
  } else {
    const match2 = currentVersion.match(/^(\d+\.\d+\.\d+)$/);
    if (match2) {
      nextVersion = `${match2[1]}-next.0`;
    } else {
      process.exit(1);
    }
  }
} else {
  let override = '';
  try {
    override = readFileSync(join(root, '.version-override'), 'utf8').trim();
  } catch {
    // no override file
  }
  if (!override) {
    try {
      const commits = execSync(`git log "v${currentVersion}"..HEAD --format=%B`, { encoding: 'utf8' });
      const releaseAs = commits.match(/^Release-As:\s*(.+)$/m);
      if (releaseAs) {
        override = releaseAs[1].trim();
      }
    } catch {
      // no commits
    }
  }

  if (override) {
    nextVersion = override;
  } else {
    const parts = currentVersion.split('.').map(Number);
    parts[2] += 1;
    nextVersion = parts.join('.');
  }
}

console.log(nextVersion);
