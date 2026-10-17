import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(root, 'plugins', 'huaweicloud-core');
const srcDir = join(pluginDir, 'src');
const distDir = join(pluginDir, 'dist');
const stagingDir = join(pluginDir, 'dist.new');

// Compile into a staging directory and swap it in only on success. Deleting
// dist up front would leave every runtime entry point dead after a type error,
// and the failure would surface as a confusing missing-module error instead of
// the compile diagnostics.
rmSync(stagingDir, { recursive: true, force: true });

// Diagnostics go to stderr only: `npm pack --json` parses stdout as JSON, and
// this script runs as the prepack hook.
const tsc = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    join(pluginDir, 'tsconfig.json'),
    '--outDir',
    stagingDir,
  ],
  { encoding: 'utf8' },
);
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout ?? '');
  process.stderr.write(tsc.stderr ?? '');
  rmSync(stagingDir, { recursive: true, force: true });
  process.exit(tsc.status ?? 1);
}

// tsc emits scripts only. Assets read through __dirname (icons manifest, sandbox
// helper) must land next to the emitted code or dist fails at runtime. The
// pack-owned skill sources (src/packs/*/skills/) are markdown, not runtime
// assets — skipping them keeps dist free of copies that per-agent installs
// would otherwise drag along permanently.
const scriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
let copied = 0;
for (const file of walk(srcDir)) {
  if (scriptExtensions.has(extname(file))) continue;
  if (/^packs[/\\][^/\\]+[/\\]skills[/\\]/.test(relative(srcDir, file))) continue;
  const dest = join(stagingDir, relative(srcDir, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  copied += 1;
}

// Single bundled entry: agent plugin dirs ship a copied dist/ whose only
// node_modules is undici (installRuntimeDeps), so every non-node dependency
// of the server entry (SDK, zod, all local modules) must be inlined here.
// undici stays external for the installer-provisioned copy and the
// node:undici built-in fallback. The remote transport ships only inside the
// bundle; --transport remote on the main entry is the supported path.
//
// The bundle runs inside the staging dir and dist is swapped only after the
// whole build succeeds. Swapping first would leave a thin tsc entry that
// imports the SDK from node_modules: runnable in-repo, dead in agent plugin
// dirs. throwOnError makes esbuild failures fail the build instead of
// producing a broken bundle.
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [join(stagingDir, 'mcp-server.js')],
    outdir: stagingDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['undici'],
    sourcemap: 'external',
    logLevel: 'warning',
    allowOverwrite: true,
  });
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
rmSync(join(stagingDir, 'mcp-server-remote.js'), { force: true });

rmSync(distDir, { recursive: true, force: true });
renameSync(stagingDir, distDir);

// The skills tree is a build artifact beside dist/: sources live in
// src/packs/*/skills/** (all 30 skills are pack-owned), output lands in
// skills/ with the roster manifest. sync-skills applies the same staging
// discipline used for dist above (render into a unique skills.new-* dir,
// swap on success), so a failed skills generation never leaves a
// half-written tree behind.
const { writeSkillsTree } = await import('./sync-skills.mjs');
const skillsOut = writeSkillsTree();

console.error(
  `[build-plugin] dist rebuilt; ${copied} asset(s) copied; server entry bundled; ` +
    `skills tree regenerated (${skillsOut.skills} skill(s), ${skillsOut.files} file(s)).`,
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
