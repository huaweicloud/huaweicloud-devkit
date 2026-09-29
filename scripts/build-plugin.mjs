import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(root, 'plugins', 'huaweicloud-core');
const srcDir = join(pluginDir, 'src');
const distDir = join(pluginDir, 'dist');

// tsc never deletes outputs for sources that were renamed or removed, so a stale
// module would keep shipping. dist must mirror src exactly.
rmSync(distDir, { recursive: true, force: true });

// Diagnostics go to stderr only: `npm pack --json` parses stdout as JSON, and
// this script runs as the prepack hook.
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pluginDir, 'tsconfig.json')],
  { encoding: 'utf8' },
);
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout ?? '');
  process.stderr.write(tsc.stderr ?? '');
  process.exit(tsc.status ?? 1);
}

// tsc emits scripts only. Assets read through __dirname (icons manifest, sandbox
// helper) must land next to the emitted code or dist fails at runtime.
const scriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
let copied = 0;
for (const file of walk(srcDir)) {
  if (scriptExtensions.has(extname(file))) continue;
  const dest = join(distDir, relative(srcDir, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  copied += 1;
}

console.error(`[build-plugin] dist rebuilt; ${copied} non-script asset(s) copied.`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
