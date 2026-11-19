import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot, readJson, root } from './structure-helpers.ts';

// Only the MCP server entry is esbuild-bundled; scripts/build-plugin.mjs
// inlines the SDK and zod into it. Every other file under dist/ is a thin tsc
// emit that keeps its bare imports, and the whole tree ships in the tarball —
// harness integrations import those subpaths instead of spawning the server.
// The published 2.0.0-next.4 package declared zod and the MCP SDK in
// devDependencies only, so a clean `npm i` made `import
// dist/tool-schemas.js` die with ERR_MODULE_NOT_FOUND. Anything the shipped
// thin modules import at runtime has to be a real dependency of the package.
const bundledEntries = new Set(['mcp-server.js']);

// npm package names only: a message string that happens to read `from "..."`
// must not be mistaken for an import (the dist emits user-facing error text).
const packageSpecifier = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/i;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function bareSpecifiers(source: string): string[] {
  const matches = source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g);
  return [...matches]
    .map((match) => match[1] ?? match[2]!)
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && packageSpecifier.test(specifier))
    .map(packageNameOf);
}

test('every bare import in the shipped thin dist modules is a declared dependency', () => {
  const distDir = join(pluginRoot, 'dist');
  assert.ok(existsSync(distDir), 'built dist/ missing under plugins/huaweicloud-core/ — run: npm run build');

  const manifest = readJson(join(root, 'package.json')) as PackageManifest;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  const undeclared: string[] = [];
  for (const file of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.js') || bundledEntries.has(file.name)) continue;
    const source = readFileSync(join(file.parentPath, file.name), 'utf8');
    for (const specifier of bareSpecifiers(source)) {
      if (!declared.has(specifier)) undeclared.push(`${specifier} ← dist/${file.name}`);
    }
  }

  assert.deepEqual(
    [...new Set(undeclared)].sort(),
    [],
    'thin dist modules import packages the published package does not declare; a clean install cannot load them',
  );
});

test('the thin entries named in the 2.0.0-next.4 report ship in dist', () => {
  for (const entry of ['tool-schemas.js', 'mcp-protocol.js']) {
    assert.ok(existsSync(join(pluginRoot, 'dist', entry)), `built dist/${entry} is missing`);
  }
});