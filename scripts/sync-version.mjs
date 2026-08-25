import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = join(root, 'package.json');
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');
const manifestPaths = [
  join(pluginRoot, '.codex-plugin', 'plugin.json'),
  join(pluginRoot, '.claude-plugin', 'plugin.json'),
  join(pluginRoot, '.cursor-plugin', 'plugin.json'),
  join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
  join(pluginRoot, '.hermes-plugin', 'plugin.json'),
];

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
let changed = false;

for (const path of manifestPaths) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.version !== version) {
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`Synced ${path} to version ${version}`);
    changed = true;
  }
}

if (!changed) {
  console.log('Versions already in sync.');
}
