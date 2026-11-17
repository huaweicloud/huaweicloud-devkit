// The Codex CLI agent module, split for the complex-file bar: this file
// keeps the codex CLI marketplace/plugin lifecycle (including the pre-fix
// telemetry-sibling healing). The Codex Desktop plugin-dir deploy with its
// personal-marketplace registration, the shared .mcp.json + .codex-plugin
// manifest writer (also used by OpenClaw's deploy), and the desktop
// status/uninstall live in agents/codex-desktop.ts.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { PACKAGE_ROOT, payloadStatusLines, removeIfExists } from '../install-payload.ts';
import { resolvePacksFlag } from '../packs-policy.ts';
import { codexPluginProbe, getCodexPluginName, getMarketplaceName } from '../codex-probe.ts';
import { asRecord } from '../lib/as-record.ts';
import { codexDesktopPluginsDir, codexMarketplacePath } from '../targets.ts';

export function hasCodexCLI(): boolean {
  const r = spawnSync('codex --version', [], { shell: true, windowsHide: true, stdio: 'pipe', timeout: 5000 });
  if (r.status === 0 && r.stdout && r.stdout.toString().includes('codex')) return true;
  // WindowsApps codex.exe may fail with "Access is denied"
  // Fallback: check if codex exists on PATH via where.exe
  if (process.platform === 'win32') {
    const w = spawnSync('where.exe', ['codex'], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    if (w.status === 0 && w.stdout.toString().trim()) return true;
  }
  return false;
}

// Pre-resolvePluginDir payloads wrote their telemetry stamps to the codex
// plugin cache's version PARENT (see resolvePluginDir in telemetry.ts): the
// stray 'telemetry' sibling then wins codex's version-dir scan — `codex
// plugin list` reports version "telemetry" and no session loads the plugin's
// manifest or .mcp.json. Only entries this allowlist proves ours are swept;
// anything else is left untouched with a warning that names the consequence.
const CODEX_TELEMETRY_STAMP_FILES = new Set([
  'install-stamp',
  'install-counter',
  'dau-stamp',
  'first-use-stamp',
  'hook-events.jsonl',
  'hook-events.jsonl.processing',
  'telemetry-debug.log',
]);

function sweepCodexCacheTelemetrySibling(): void {
  const stray = join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'plugins',
    'cache',
    getMarketplaceName(),
    getCodexPluginName(),
    'telemetry',
  );
  if (!existsSync(stray)) return;
  try {
    const entries = readdirSync(stray);
    // An EMPTY dir is swept unconditionally: it is ours by location (this
    // path is scoped to our own marketplace/plugin cache namespace, where
    // codex only ever creates version-named dirs; an empty dir there has
    // no content to lose and poisons codex's version scan exactly like a
    // full one). entries.every is vacuously true for it — and that shape is
    // reachable from a crashed prior sweep (rmSync deleting entries, then
    // killed before the dir), so requiring non-emptiness would permanently
    // disable the healing for that cache.
    const provablyOurs = entries.every(
      (name) => CODEX_TELEMETRY_STAMP_FILES.has(name) && statSync(join(stray, name)).isFile(),
    );
    if (!provablyOurs) {
      console.log(
        `  \x1b[33mPre-fix telemetry sibling present but not provably ours — codex cannot load the plugin while it exists.\x1b[0m`,
      );
      console.log(`  \x1b[33mInspect and remove it manually: rm -rf "${stray}"\x1b[0m`);
      return;
    }
    rmSync(stray, { recursive: true, force: true });
    console.log(`  Healed pre-fix telemetry sibling: ${stray}`);
  } catch {
    // unreadable content is not provably ours; leave it and say what that means
    console.log(
      `  \x1b[33mPre-fix telemetry sibling present but unreadable — codex cannot load the plugin while it exists.\x1b[0m`,
    );
    console.log(`  \x1b[33mInspect and remove it manually: rm -rf "${stray}"\x1b[0m`);
  }
}

// One spawn+print shape for every `codex plugin …` / `codex plugin
// marketplace …` call: output (stdout, else stderr) is echoed either way so
// the transcript shows what the CLI answered even on failure.
function runCodexCliCommand(command: string): SpawnSyncReturns<string> {
  const r = spawnSync(command, [], { shell: true, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);
  return r;
}

export function installCodex(): boolean {
  // --packs has no write path here: the codex CLI owns this target's MCP
  // config. Say so once and continue; the install itself is unaffected.
  if (resolvePacksFlag().kind !== 'unset') {
    console.log('  \x1b[33mcodex target is managed by codex CLI; set DEVKIT_PACKS in its MCP config manually\x1b[0m');
  }
  const marketplaceRoot = PACKAGE_ROOT;
  const pluginName = getCodexPluginName();
  const marketplaceName = getMarketplaceName();

  console.log(`  Registering Codex marketplace: ${marketplaceRoot}`);
  let r1 = runCodexCliCommand(`codex plugin marketplace add "${marketplaceRoot}"`);

  if (r1.status !== 0 && /already added.*different source/i.test((r1.stderr || '').toString())) {
    // A same-name marketplace registered from another source (an npm-cache
    // install being replaced by a local checkout, or the reverse) blocks the
    // add. Re-registering over it is the install intent, so remove the stale
    // registration and retry once. The plugin removal is best-effort (the
    // marketplace remove is the load-bearing step; a plugin that was never
    // installed under this name must not block the transition), and the
    // retry copies a fresh payload into the cache either way.
    console.log(`  Marketplace already registered from a different source; re-registering`);
    runCodexCliCommand(`codex plugin remove "${pluginName}@${marketplaceName}"`);
    runCodexCliCommand(`codex plugin marketplace remove "${marketplaceName}"`);
    r1 = runCodexCliCommand(`codex plugin marketplace add "${marketplaceRoot}"`);
  }

  if (r1.status !== 0 && /Access is denied/i.test((r1.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }
  if (r1.status !== 0) {
    console.log(`  \x1b[31mCodex marketplace registration failed.\x1b[0m`);
    return false;
  }

  // Heal any pre-fix telemetry sibling before `codex plugin add` so the add
  // operates on a sane cache; the fixed payload never recreates it.
  sweepCodexCacheTelemetrySibling();

  console.log(`  Installing plugin: ${pluginName}@${marketplaceName}`);
  const r2 = runCodexCliCommand(`codex plugin add "${pluginName}@${marketplaceName}"`);

  if (r2.status !== 0 && /Access is denied/i.test((r2.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }
  if (r2.status !== 0) {
    console.log(`  \x1b[31mCodex plugin installation failed.\x1b[0m`);
    return false;
  }

  // The client yield (PR-5) needs no step here: the per-tool approve blocks
  // ship inside the plugin payload's own .mcp.json (the repo's
  // plugins/huaweicloud-core/.mcp.json, which `codex plugin add` copies
  // into its cache) — the file codex reads per-tool approval_mode from for
  // a plugin-provided server (agents/codex-config.ts). The user's
  // config.toml is never touched: a tools table under
  // [mcp_servers.huaweicloud-devkit] would imply a config-declared server,
  // and without a transport codex refuses to load the whole config
  // (live-measured "invalid transport" on codex-cli 0.167.2).

  return true;
}

export function uninstallCodex(): void {
  const pluginName = getCodexPluginName();
  const marketplaceName = getMarketplaceName();
  for (const name of new Set([pluginName, 'huaweicloud-core'])) {
    console.log(`  Removing Codex plugin: ${name}@${marketplaceName}`);
    const r = spawnSync(`codex plugin remove "${name}@${marketplaceName}"`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);
  }

  for (const name of new Set([marketplaceName, 'HuaweiCloud-Devkit'])) {
    console.log(`  Removing Codex marketplace: ${name}`);
    const r2 = spawnSync(`codex plugin marketplace remove "${name}"`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`  ${r2.stdout ? r2.stdout.toString().trim() : r2.stderr.toString().trim()}`);
    // `codex plugin remove` strips the version subtrees but leaves the
    // marketplace-keyed cache dir behind (live-verified on codex-cli
    // 0.162.1: only the empty shell survives the CLI's own cleanup); the
    // registration was ours, so its cache shell is ours to remove. Gated on
    // the remove having exited 0 — if the CLI refused (or was unable) to
    // remove the marketplace, the registration is still live and deleting
    // its cache would break a still-registered plugin. CODEX_HOME mirrors
    // the CLI's own home resolution so the cleanup follows whatever root
    // the spawned `codex plugin` commands above actually used.
    if (r2.status === 0) {
      const cacheDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', name);
      if (removeIfExists(cacheDir)) {
        console.log(`  Codex plugin cache cleaned: ${name}`);
      }
    }
  }
}

export function codexStatus(): boolean {
  const probe = codexPluginProbe();
  return probe.ok && probe.installed;
}

export function codexSectionStatus(): void {
  if (!hasCodexCLI()) {
    console.log('  \x1b[33mCodex CLI not found.\x1b[0m');
  } else {
    console.log(`  Plugin: ${codexStatus() ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  }
}

// Codex Desktop serves the payload from its own plugin dir plus a
// marketplace registration under ~/.agents/plugins/marketplace.json —
// status reports both surfaces (previously the one target cmdStatus did
// not cover at all; the release smoke had to skip its status check). Lives
// beside the other codex status faces (agents/codex-desktop.ts owns the
// deploy/marketplace-write family).
export function codexDesktopStatus(): void {
  payloadStatusLines(codexDesktopPluginsDir());
  const mpPath = codexMarketplacePath();
  if (existsSync(mpPath)) {
    try {
      const marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
      const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
      // The canonical plugin name — the same derived value
      // ensureCodexMarketplaceEntry writes and removeCodexMarketplaceEntry
      // filters on (all three ride getCodexPluginName).
      const registered = plugins.some((p) => asRecord(p).name === getCodexPluginName());
      console.log(`  Marketplace: ${registered ? '\x1b[32mRegistered\x1b[0m' : '\x1b[31mNot registered\x1b[0m'}`);
    } catch {
      console.log(`  Marketplace: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  Marketplace: \x1b[31mNot registered\x1b[0m`);
  }
}
