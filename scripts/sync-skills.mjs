#!/usr/bin/env node
// Skill dual-source sync for the v2-pack program.
//
// The authoritative sources of the pack-owned skills live inside their packs:
//   plugins/huaweicloud-core/src/packs/<id>/skills/<name>/**
// The install/runtime tree stays at the historic location agents read:
//   plugins/huaweicloud-core/skills/<name>/**
// That tree is GENERATED: each authoritative file is copied with one marker
// line injected (an HTML comment, inert for agents and for markdownlint)
// right after the YAML frontmatter (or at the top when a file has no
// frontmatter). `npm run build` regenerates it as a build artifact beside
// dist/ (writeSkillsTree below), `--write` does the same on demand, and
// `--check` re-derives the expectation and fails on any drift, printing the
// authoritative path and the fix command (`npm run build`).
//
// Every skill — meta and service alike — is pack-owned: src/packs/core/
// carries the six meta-skills, the other packs carry their service skills,
// and the whole skills/ tree is generated. Non-markdown payloads
// (agents/*.yaml manifests) copy verbatim: the marker is an HTML comment,
// legal in markdown and invalid YAML — only .md files carry markers.
//
// Writing follows the staging discipline build-plugin.mjs applies to dist/:
// render everything into a unique skills.new-* staging dir, write the roster
// manifest, and swap only on success — a crashed run can never leave a
// half-written tree where a complete one stood. The swap replaces the whole
// tree, so stray hand-created directories under skills/ are wiped exactly
// like stale files; the tree is wholly derived, same as dist/.
//
// CRLF is normalized to LF before comparison; the injected marker line itself
// is stripped from the generated side so content compares byte-level.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The stray-dir scan must see exactly what the boot guard sees, so both use
// the one SKILL.md-aware listing. Type stripping carries the .ts import on
// the floor the whole build chain requires (engines: >= 22.18 — build,
// validate, and prepack all run this script).
import { listSkillDirs } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(repoRoot, 'plugins', 'huaweicloud-core');
const packsDir = join(pluginRoot, 'src', 'packs');
const skillsDir = join(pluginRoot, 'skills');

const MARKER_PREFIX = '<!-- generated from ';
const MARKER_SUFFIX = ' - do not edit -->';
const MANIFEST_NAME = '.manifest.json';

function markerFor(packId, skillName) {
  return `${MARKER_PREFIX}src/packs/${packId}/skills/${skillName}${MARKER_SUFFIX}`;
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Every directory under src/packs/<id>/skills/ is a pack-owned skill source.
// The root is injectable so tests can point at an empty/fixture tree.
function discoverPackSkills(sourceRoot = packsDir) {
  const out = [];
  for (const packId of listDirs(sourceRoot)) {
    const packSkillsDir = join(sourceRoot, packId, 'skills');
    for (const skillName of listDirs(packSkillsDir)) {
      out.push({ packId, skillName, sourceDir: join(packSkillsDir, skillName) });
    }
  }
  return out;
}

// Inject the marker as a pure insertion: right after the YAML frontmatter
// closing delimiter for SKILL.md, first line otherwise. Prettier later
// settles a blank line between the frontmatter block and the marker;
// stripMarkerLine tolerates both shapes, so --write output passes --check
// with or without a format pass (strip∘render is the identity).
function renderGenerated(packId, skillName, relativeFile, content) {
  const normalized = content.replace(/\r\n/g, '\n');
  // Non-markdown payloads (agents/*.yaml) copy verbatim: the marker is an
  // HTML comment, legal in markdown and invalid YAML. --check compares
  // these files byte-level against the pack sources (stripMarkerLine is
  // the identity without a marker), so omitting the marker loses nothing.
  if (!relativeFile.endsWith('.md')) return normalized;
  const marker = markerFor(packId, skillName);
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(normalized);
  if (frontmatter && relativeFile === 'SKILL.md') {
    const cut = frontmatter[0].length;
    // Prettier-settled shape: one blank line between the frontmatter block
    // and the marker (the source's own blank after the frontmatter
    // separates marker from content). Emitting the settled shape closes
    // the format loop structurally — the raw insertion previously failed
    // format:check, so every sync-without-format re-broke CI exactly the
    // way the batch-3 commit did (round-10 finding). stripMarkerLine
    // tolerates both shapes, so the --check round-trip is unaffected.
    return `${normalized.slice(0, cut)}\n${marker}\n${normalized.slice(cut)}`;
  }
  // Reference files: prettier settles one blank after a first-line marker.
  // A source that already starts with a blank produces that shape under
  // the plain concatenation; otherwise the blank is inserted here.
  return `${marker}\n${normalized.startsWith('\n') ? normalized : `\n${normalized}`}`;
}

// Strip the injected marker line (wherever it sits — first line for files
// without frontmatter, right after the frontmatter for SKILL.md) and
// normalize CRLF, yielding content comparable to the authoritative source.
// Prettier settles one blank line around the marker: between the frontmatter
// block and the marker for SKILL.md (detected by both neighbors blank — the
// other blank is the source's own), or after a first-line marker for
// reference files (detected by the missing left neighbor). Exactly that one
// blank is undone; every other case is a pure removal, the inverse of the
// insertion renderGenerated performs.
function stripMarkerLine(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const index = lines.findIndex((line) => line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX));
  if (index === -1) return normalized;
  lines.splice(index, 1);
  const after = lines[index];
  const beforeBlank = index > 0 && lines[index - 1] === '';
  if (after === '' && (beforeBlank || index === 0)) lines.splice(index, 1);
  return lines.join('\n');
}

// The marker line a generated file must carry, or null when absent. --check
// compares it against markerFor(packId, skillName): the content comparison
// below strips the marker before comparing, so without this check a stale
// marker path (a pack directory renamed with --write skipped) survives every
// gate, including prepack.
function markerLineOf(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized.split('\n').find((line) => line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX)) ?? null;
}

// The roster manifest travels with the generated tree (prettier-clean JSON):
// consumers (doctor's roster check, pack verification, the native-skill sync)
// read it instead of re-deriving the expectation from src/packs. Invisible
// to every skill reader — not a directory, no SKILL.md, no huawei* prefix.
// packOf is the per-skill pack claim: the installer derives "which names may
// go native" from it (core-pack skills only) without importing the
// zod-dependent registry, and dsh-postinstall.cjs reads the same JSON.
function manifestJson(packSkills) {
  // Code-unit ordering, not localeCompare: the manifest is a byte-compared
  // build artifact shipped verbatim, so its bytes must not depend on the
  // host's locale/ICU data.
  const roster = packSkills.map(({ skillName }) => skillName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const packOf = {};
  for (const name of roster) packOf[name] = packSkills.find(({ skillName }) => skillName === name).packId;
  return `${JSON.stringify({ generatedBy: 'scripts/sync-skills.mjs', skills: roster, packOf }, null, 2)}\n`;
}

// Full regeneration with the staging discipline build-plugin.mjs applies to
// dist/: render every source into a unique skills.new-* staging dir beside
// the target, write the manifest, swap only on success. The rm+rename pair
// leaves the same two-statement missing window the dist swap accepts; the
// fail-loud seams cover it. Replacing the whole tree (not incremental
// writes) is what makes stale files, stale skill dirs, and stray
// hand-created dirs vanish in one pass. A unique staging dir (mkdtemp)
// keeps two entry points — npm run build and npm run skills:sync — from
// clobbering each other's staging: concurrent runs either fail cleanly at
// the rename or last-writer-wins with a complete tree; a partial tree never
// publishes.
export function writeSkillsTree({ packsDir: sourceRoot = packsDir, outDir = skillsDir } = {}) {
  const packSkills = discoverPackSkills(sourceRoot);
  if (packSkills.length === 0) {
    throw new Error(
      `no pack skill sources found under ${relative(repoRoot, sourceRoot)} — refusing to replace the skills tree`,
    );
  }
  const stagingParent = dirname(outDir);
  // Sweep stale staging dirs in the target's parent: preserved recovery
  // copies and crash leftovers. Freshness is the discriminator, and the
  // safety margin is structural: only DIRECT children of the staging dir
  // (each skill dir's creation, the manifest write) update its own mtime —
  // files inside skill subdirs do not — and those direct-child touches
  // bracket the whole render, so no legitimate writer goes an hour between
  // its last direct-child touch and its swap. A just-preserved recovery
  // copy is likewise fresh and survives a prompt re-run.
  const staleBefore = Date.now() - 60 * 60 * 1000;
  for (const entry of readdirSync(stagingParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('skills.new-')) continue;
    const stale = join(stagingParent, entry.name);
    try {
      if (statSync(stale).mtimeMs < staleBefore) rmSync(stale, { recursive: true, force: true });
    } catch {
      // an unreadable staging dir is not worth failing the build over
    }
  }
  const stagingSkillsDir = mkdtempSync(join(stagingParent, 'skills.new-'));
  // Once rendering completes, the staging dir is the only guaranteed
  // complete copy: the swap may have already damaged the live tree when it
  // fails (rmSync can throw midway on a locked file, not just renameSync),
  // so a post-render failure must preserve the staging dir for recovery.
  let renderComplete = false;
  try {
    let files = 0;
    for (const { packId, skillName, sourceDir } of packSkills) {
      const targetDir = join(stagingSkillsDir, skillName);
      for (const file of walkFiles(sourceDir)) {
        const sourceContent = readFileSync(join(sourceDir, file), 'utf8').replace(/\r\n/g, '\n');
        const targetPath = join(targetDir, file);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, renderGenerated(packId, skillName, file, sourceContent));
        files += 1;
      }
    }
    writeFileSync(join(stagingSkillsDir, MANIFEST_NAME), manifestJson(packSkills));
    renderComplete = true;
    rmSync(outDir, { recursive: true, force: true });
    renameSync(stagingSkillsDir, outDir);
    return { skills: packSkills.length, files };
  } catch (error) {
    if (renderComplete) {
      // stderr only: npm pack --json parses stdout and the build chain runs
      // as the prepack hook. The hint covers both interleavings honestly:
      // re-running the build is always safe (it sweeps stale staging dirs);
      // a manual rename is only correct when the target is truly absent.
      console.error(
        `skills tree swap failed; the rendered copy is preserved at ${stagingSkillsDir} — ` +
          `re-run npm run build, or if ${outDir} is absent rename the preserved dir into place`,
      );
    } else {
      rmSync(stagingSkillsDir, { recursive: true, force: true });
    }
    throw error;
  }
}

// Check mode re-derives the expectation from the pack sources and compares
// byte-level (marker-stripped, CRLF-normalized), plus the manifest equality
// and the stray scan. Roots are injectable so the committed tests can drive
// check mode against fixture trees without touching the real ones.
function run({ write = false, packsDir: sourceRoot = packsDir, outDir: treeDir = skillsDir } = {}) {
  if (write) {
    const { skills, files } = writeSkillsTree({ packsDir: sourceRoot, outDir: treeDir });
    return { failures: [], packSkills: skills, files };
  }
  const failures = [];
  const packSkills = discoverPackSkills(sourceRoot);
  const expectedTargets = new Set(packSkills.map(({ skillName }) => skillName));

  for (const { packId, skillName, sourceDir } of packSkills) {
    const targetDir = join(treeDir, skillName);
    for (const file of walkFiles(sourceDir)) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);
      const sourceContent = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
      if (!existsSync(targetPath)) {
        failures.push(
          `missing generated file: ${relative(repoRoot, targetPath)} (source: ${relative(repoRoot, sourcePath)})`,
        );
        continue;
      }
      const rawTarget = readFileSync(targetPath, 'utf8');
      // Non-markdown payloads carry no marker (see renderGenerated).
      const expectedMarker = file.endsWith('.md') ? markerFor(packId, skillName) : null;
      const actualMarker = markerLineOf(rawTarget);
      if (actualMarker !== expectedMarker) {
        failures.push(
          `stale generated marker in ${relative(repoRoot, targetPath)}: expected "${expectedMarker}", found ${actualMarker ?? 'none'} — run: npm run build`,
        );
      }
      const actualStripped = stripMarkerLine(rawTarget);
      if (actualStripped !== sourceContent) {
        failures.push(
          `drift in ${relative(repoRoot, targetPath)} (authoritative source: ${relative(repoRoot, sourcePath)}) — run: npm run build`,
        );
      }
    }
  }

  // Stray skill dirs — marker or not — must fail here: the boot guard
  // (verifySkillTree) rejects any tree entry it can list and the registry
  // does not claim, so this scan uses the same shared listing
  // (src/lib/skill-tree.ts). A dir without a SKILL.md is invisible to both
  // — parity, not an accident.
  for (const name of listSkillDirs(treeDir)) {
    if (!expectedTargets.has(name)) {
      failures.push(
        `stray skill dir with no pack source: ${relative(repoRoot, join(treeDir, name))} — run: npm run build`,
      );
    }
  }

  // The manifest must be present and current (it ships with the tree).
  const manifestPath = join(treeDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    failures.push(`missing skills manifest: ${relative(repoRoot, manifestPath)} — run: npm run build`);
  } else if (readFileSync(manifestPath, 'utf8') !== manifestJson(packSkills)) {
    failures.push(`stale skills manifest: ${relative(repoRoot, manifestPath)} — run: npm run build`);
  }

  return { failures, packSkills: packSkills.length };
}

// pathToFileURL, not `new URL('file://' + argv[1])`: the string form never
// matches import.meta.url on Windows (backslash, drive-letter paths), which
// silently turned the --check/--write CLI into a no-op there.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write');
  if (!write && !args.has('--check')) {
    console.error('usage: node scripts/sync-skills.mjs --write | --check');
    process.exit(2);
  }

  const { failures, packSkills, files } = run({ write });
  if (failures.length > 0) {
    console.error(`skills sync ${write ? 'reported' : 'check'} FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    if (!write) console.error('Fix with: npm run build');
    process.exit(1);
  }
  // stdout stays empty: npm pack --json parses stdout as JSON and this script
  // runs as the prepack tail (same stderr-only rule as build-plugin.mjs).
  console.error(
    `skills sync ${write ? 'wrote' : 'check OK'}: ${packSkills} pack skill(s)${write ? `, ${files} file(s)` : ''} in sync.`,
  );
}

// The round-trip pair is exported for the packs-sync test: --write output
// must pass --check without a prettier pass in between. writeSkillsTree is
// consumed by build-plugin.mjs (the skills tree is a build artifact); run is
// the check-mode seam the fixture tests drive.
export { renderGenerated, stripMarkerLine, run };
