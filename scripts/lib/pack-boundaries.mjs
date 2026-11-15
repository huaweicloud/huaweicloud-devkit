// Per-pack import boundary guard for the v2-pack program.
//
// Every module under src/packs/<id>/ may only import:
//   - node:* builtins, zod, and undici (contract-external baseline; the
//     package.json npm manifest only governs ADDITIONAL runtime deps),
//   - its own pack root (src/packs/<ownId>/),
//   - src/lib/ (shared value+type code hoisted out of core),
//   - the core shared whitelist below (value+type),
//   - any core src/ file TYPE-ONLY (import type / export type ... from),
//   - src/packs/registry.ts TYPE-ONLY.
//
// Forbidden:
//   - sibling packs (src/packs/<otherId>/) — value OR type,
//   - value imports of src/packs/registry.ts (composition root),
//   - anything else (bare modules, files outside the whitelist, non-core
//     paths under src/).
//
// src/packs/registry.ts itself is NOT scanned: it is the sanctioned
// composition root whose job is to import every pack.
//
// Judgement is made on the RESOLVED ABSOLUTE path of each specifier (never
// on specifier string prefixes, which '../lib/../sandbox/' style paths could
// evade), using the TypeScript compiler API to find ImportDeclaration,
// ExportDeclaration, and literal dynamic import() expressions with their
// isTypeOnly flag and source line.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The TypeScript compiler API is loaded lazily through createRequire so
// static import analyzers (eslint import-x cycle detection) do not pull the
// multi-megabyte typescript module graph into their own heap.
const require = createRequire(import.meta.url);
const ts = require('typescript');

// Core files a pack may value-import (in addition to type-only edges).
const CORE_VALUE_FILES = [
  'src/tools.ts',
  'src/tool-schemas.ts',
  'src/update-check.ts',
  'src/mcp-protocol.ts',
  'src/hcloud-cli.ts',
  'src/hcloud-probe.ts',
  'src/safety-policy.ts',
  'src/risk-rule-engine.ts',
  'src/koocli-version.ts',
  'src/search-market.ts',
  'src/icon-library.ts',
  'src/detect-framework.ts',
  // The approval-gate leaves, both zod-free by contract: approval-types.ts
  // carries the ApprovalSpec/ConsentEvent vocabulary a pack's spec table
  // imports, approval-roster.ts the plain string arrays the hook graph and
  // the opencode writer share. The gate (approval-gate.ts) and the ledger
  // (approval-ledger.ts) stay unlisted on purpose — packs register data,
  // they never run the gate or write the store themselves.
  'src/approval-types.ts',
  'src/approval-roster.ts',
];

// Core directories a pack may value-import (in addition to type-only edges).
const CORE_VALUE_DIRS = ['src/sandbox/', 'src/auth/', 'src/proxy/', 'src/telemetry/', 'src/ws-exec/'];

// Contract-external baseline modules. The package.json manifest governs the
// published dependency surface (one runtime dep: undici); zod ships inlined
// into the bundle at build time. These three stay outside that manifest, so
// they are listed here instead.
const BASELINE_MODULES = new Set(['zod', 'undici']);

function listPackFiles(packsDir) {
  const out = [];
  if (!existsSync(packsDir)) return out;
  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // registry.ts and other root files are not pack modules
    const packRoot = join(packsDir, entry.name);
    for (const file of walkTs(packRoot)) out.push({ packId: entry.name, packRoot, file });
  }
  return out;
}

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function collectImports(sourceFile) {
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        isTypeOnly: node.importClause?.isTypeOnly === true,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        isTypeOnly: node.isTypeOnly === true,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      // Dynamic import with a literal specifier: always a value edge.
      imports.push({
        specifier: node.arguments[0].text,
        isTypeOnly: false,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return imports;
}

function contains(parentDir, targetPath) {
  const rel = relative(parentDir, targetPath);
  return rel !== '' && !rel.startsWith('..');
}

function classify({ specifier, isTypeOnly, file, packId, packRoot, srcDir, packsDir, pluginRoot }) {
  if (!specifier.startsWith('.')) {
    if (specifier.startsWith('node:')) return null;
    if (BASELINE_MODULES.has(specifier)) return null;
    return `bare module "${specifier}" is not in the pack allowlist (node:*, zod, undici)`;
  }
  const target = resolve(dirname(file), specifier);
  // Own pack root: anything goes.
  if (contains(packRoot, target)) return null;
  // Shared library hoist.
  if (contains(join(srcDir, 'lib'), target)) return null;
  // The registry is importable type-only (composition root).
  const registryPath = join(packsDir, 'registry.ts');
  if (target === registryPath) {
    return isTypeOnly ? null : 'value import of src/packs/registry.ts (type-only allowed)';
  }
  // Sibling packs are off limits entirely.
  if (contains(packsDir, target)) {
    const rel = relative(packsDir, target);
    const otherId = rel.split(/[\\/]/)[0];
    if (otherId !== packId) return `sibling pack src/packs/${otherId}/ is not importable`;
  }
  // Whitelisted core files and directories: value+type.
  for (const coreFile of CORE_VALUE_FILES) {
    if (target === join(pluginRoot, coreFile)) return null;
  }
  for (const coreDir of CORE_VALUE_DIRS) {
    if (contains(join(pluginRoot, coreDir), target)) return null;
  }
  // Any other core src/ file is allowed type-only.
  if (contains(srcDir, target)) {
    return isTypeOnly ? null : `value import of ${relative(srcDir, target)} is not in the core shared whitelist`;
  }
  return isTypeOnly ? `type import outside src/ (${relative(srcDir, target)})` : `import outside the pack boundary`;
}

export function checkPackBoundaries({ root } = {}) {
  const repoRoot = resolve(root ?? fileURLToPath(new URL('../..', import.meta.url)));
  const pluginRoot = join(repoRoot, 'plugins', 'huaweicloud-core');
  const srcDir = join(pluginRoot, 'src');
  const packsDir = join(srcDir, 'packs');
  const violations = [];
  let packFiles = 0;
  for (const { packId, packRoot, file } of listPackFiles(packsDir)) {
    packFiles++;
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const imp of collectImports(sourceFile)) {
      const reason = classify({
        specifier: imp.specifier,
        isTypeOnly: imp.isTypeOnly,
        file,
        packId,
        packRoot,
        srcDir,
        packsDir,
        pluginRoot,
      });
      if (reason) {
        violations.push({
          file: relative(repoRoot, file),
          line: imp.line,
          specifier: imp.specifier,
          reason,
        });
      }
    }
  }
  return {
    ok: violations.length === 0,
    packFiles,
    violations,
    lines: violations.map((v) => `${v.file}:${v.line}: ${v.specifier} forbidden: ${v.reason}`),
  };
}
