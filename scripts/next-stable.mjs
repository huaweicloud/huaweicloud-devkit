import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function computeNextStable() {
  let overrideBase = '';
  try {
    overrideBase = readFileSync(join(root, '.version-override'), 'utf8').trim();
  } catch {
    // no override file
  }
  if (overrideBase) return overrideBase;

  const allTags = execSync('git tag -l --sort=-version:refname', { encoding: 'utf8', cwd: root })
    .trim()
    .split('\n')
    .filter((t) => t && t.startsWith('v'));
  const stableRe = /^v(\d+)\.(\d+)\.(\d+)$/;
  let latestStable = '0.0.0';
  for (const tag of allTags) {
    const m = tag.match(stableRe);
    if (m) {
      latestStable = `${m[1]}.${m[2]}.${m[3]}`;
      break;
    }
  }
  const parts = latestStable.split('.').map(Number);
  parts[2] += 1;
  return parts.join('.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(computeNextStable());
}
