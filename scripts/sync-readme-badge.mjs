import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeNextStable } from './next-stable.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const write = process.argv.includes('--write');

const version = computeNextStable();
const expected = `badge/beta-v${version}-orange`;
const badgeRe = /(badge\/beta-v)[^)]*(-orange)/;
const targets = ['README.md', 'README.zh-CN.md'].map((f) => join(root, f));

let dirty = false;
for (const file of targets) {
  const content = readFileSync(file, 'utf8');
  const match = content.match(badgeRe);
  if (!match) {
    console.error(`[sync-readme-badge] ${file}: beta badge not found or malformed.`);
    process.exit(1);
  }
  const current = match[0];
  if (current === expected) continue;

  if (write) {
    writeFileSync(file, content.replace(badgeRe, expected), 'utf8');
    console.log(`[sync-readme-badge] ${file}: ${current} -> ${expected}`);
    dirty = true;
  } else {
    console.error(
      `[sync-readme-badge] ${file}: badge version out of sync.\n  expected: ${expected}\n  found:    ${current}\n  fix:      npm run badge:sync`,
    );
    process.exit(1);
  }
}
if (write && !dirty) console.log('[sync-readme-badge] badge up to date.');
