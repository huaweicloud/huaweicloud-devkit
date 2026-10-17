import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lookupOnPath } from './lib/dep-resolve.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const PACKAGE_ROOT = resolve(PLUGIN_ROOT, '..', '..');

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function getMarketplaceName(): string {
  const marketplacePath = join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json');
  try {
    const manifest = asRecord(JSON.parse(readFileSync(marketplacePath, 'utf8')));
    if (typeof manifest.name === 'string' && manifest.name) return manifest.name;
  } catch {
    // missing or corrupt marketplace.json means the default marketplace name
  }
  return 'huaweicloud-devkit';
}

export function getCodexPluginName(): string {
  const marketplacePath = join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json');
  try {
    const marketplace = asRecord(JSON.parse(readFileSync(marketplacePath, 'utf8')));
    const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const pluginName: unknown = asRecord(plugins[0]).name;
    if (typeof pluginName === 'string' && pluginName) return pluginName;
  } catch {
    // missing or corrupt marketplace.json falls through to the plugin manifest
  }
  const codexManifestPath = join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json');
  try {
    const manifest = asRecord(JSON.parse(readFileSync(codexManifestPath, 'utf8')));
    if (typeof manifest.name === 'string' && manifest.name) return manifest.name;
  } catch {
    // missing or corrupt plugin manifest means the default plugin name
  }
  return 'huaweicloud-devkit';
}

// The codex plugin probe as a discriminated result. A successfully parsed
// `codex plugin list --json` (exit 0, valid JSON, an installed array — empty
// or not) is the only authoritative negative signal; a spawn failure,
// timeout, non-zero exit, or unparseable/shape-mismatched output is UNKNOWN,
// not "not installed" — the uninstall safety gate must treat unknown the
// same way unknown DEVKIT_PACKS ids are treated (contribute the full
// surface, fail-safe), because a probe failure must never let
// `dep uninstall` delete a binary a live codex installation still needs.
// A PATH miss is the one definitive absence: hasCodexCLI() cannot front this
// probe because its false covers BOTH "absent" and "present but failed to
// answer" (a --version timeout or odd version string), and the latter must
// read as unknown, not as a trusted negative.
export type CodexPluginProbe = { ok: true; installed: boolean } | { ok: false };

export function codexPluginProbe(): CodexPluginProbe {
  if (lookupOnPath('codex', process.env) === null) return { ok: true, installed: false };
  // Parse the structured output instead of substring-matching the table: the
  // plugin's SOURCE path (…/plugins/huaweicloud-core) also contains the name,
  // so a naive includes() reports "installed" even when the status column says
  // "not installed".
  const r = spawnSync('codex plugin list --json', [], {
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 5000,
  });
  if (r.status !== 0) return { ok: false };
  const out = r.stdout ? r.stdout.toString() : '';
  const name = getCodexPluginName();
  try {
    const data = asRecord(JSON.parse(out));
    if (!Array.isArray(data.installed)) return { ok: false };
    return {
      ok: true,
      installed: data.installed.some((p) => {
        const record = asRecord(p);
        return record.name === name || (typeof record.pluginId === 'string' && record.pluginId.startsWith(`${name}@`));
      }),
    };
  } catch {
    return { ok: false };
  }
}
