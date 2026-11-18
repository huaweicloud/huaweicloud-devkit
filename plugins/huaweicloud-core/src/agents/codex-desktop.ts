// The Codex Desktop agent module, split out of agents/codex.ts for the
// complex-file bar: the plugin-dir deploy with its personal-marketplace
// registration (~/.agents/plugins/marketplace.json), the shared .mcp.json +
// .codex-plugin manifest writer (also used by OpenClaw's deploy), and the
// desktop status/uninstall. The codex CLI marketplace/plugin lifecycle stays
// in agents/codex.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { codexDesktopPluginsDir, codexMarketplacePath } from '../targets.ts';
import { getCodexPluginName } from '../codex-probe.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  PLUGIN_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  mcpServerInstalled,
  pruneStale,
  removeHuaweiCommandsFrom,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';
import { backupDeltaFromMcpServersFile, writeMcpJsonAndCodexManifest } from '../mcp-config-io.ts';

// Doctor: the Codex Desktop MCP-configured candidate — the personal
// marketplace registration under ~/.agents/plugins/marketplace.json. The
// canonical plugin name — the same getCodexPluginName() reader
// ensureCodexMarketplaceEntry writes and removeCodexMarketplaceEntry
// filters on, so a marketplace.json rename moves all of them together.
export function codexDesktopDoctorMcpConfigured(): string | null {
  const mpPath = codexMarketplacePath();
  if (!existsSync(mpPath)) return null;
  try {
    const mp = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
    if (
      mp.plugins &&
      (Array.isArray(mp.plugins) ? mp.plugins : []).some((p) => asRecord(p).name === getCodexPluginName())
    ) {
      return 'Codex Desktop';
    }
  } catch {
    // corrupt marketplace file skips this candidate — the probe continues
  }
  return null;
}

export function ensureCodexMarketplaceEntry(): void {
  const mpPath = codexMarketplacePath();
  // The canonical plugin name: status (codexDesktopStatus), install, and
  // uninstall all derive from the same reader, so a marketplace.json rename
  // moves all three together.
  const pluginName = getCodexPluginName();
  const entry = {
    name: pluginName,
    source: { source: 'local', path: './plugins/huaweicloud-devkit' },
    policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
    category: 'Cloud',
  };

  let marketplace: Record<string, unknown> | null = null;
  if (existsSync(mpPath)) {
    try {
      marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
    } catch {
      marketplace = null;
    }
  }

  if (!marketplace || !marketplace.name || !Array.isArray(marketplace.plugins)) {
    marketplace = {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [],
    };
  }

  const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const existingIdx = plugins.findIndex((p) => asRecord(p).name === pluginName);
  let changed = false;
  if (existingIdx >= 0) {
    const existing = asRecord(plugins[existingIdx]);
    if (
      asRecord(existing.source).path !== entry.source.path ||
      asRecord(existing.policy).installation !== entry.policy.installation ||
      asRecord(existing.policy).authentication !== entry.policy.authentication
    ) {
      plugins[existingIdx] = entry;
      changed = true;
    }
  } else {
    plugins.push(entry);
    changed = true;
  }

  if (changed) {
    marketplace.plugins = plugins;
    mkdirSync(dirname(mpPath), { recursive: true });
    writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
    console.log(`  Marketplace updated: ${mpPath}`);
  } else {
    console.log(`  Marketplace unchanged: ${mpPath}`);
  }
}

export function removeCodexMarketplaceEntry(): void {
  const mpPath = codexMarketplacePath();
  if (!existsSync(mpPath)) return;
  let marketplace: Record<string, unknown>;
  try {
    marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
  } catch {
    return;
  }
  if (!marketplace.plugins) return;
  const pluginName = getCodexPluginName();
  const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const before = plugins.length;
  const filtered = plugins.filter((p) => asRecord(p).name !== pluginName);
  if (filtered.length === before) return;
  marketplace.plugins = filtered;
  writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
  console.log('  Marketplace entry removed');
}

// Codex Desktop deploy: commands, assets, and the marketplace entry. Install
// mode additionally cleans the pre-marketplace-era install locations — update
// runs on machines already past that era.
export async function deployCodexDesktop(mode: DeployMode): Promise<void> {
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const pluginDest = codexDesktopPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(commandsSrc, join(pluginDest, 'commands'));
  const staleCommands = mode === 'update' ? pruneStale(join(pluginDest, 'commands'), commandsSrc) : 0;
  console.log(
    `  Commands${deployWord(mode)} -> ${join(pluginDest, 'commands')}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyServerPayload(pluginDest);

  // Copy assets (icons, logos) for Codex Desktop plugin UI
  const codexAssetsSrc = join(PLUGIN_ROOT, 'assets');
  if (existsSync(codexAssetsSrc)) {
    copyDir(codexAssetsSrc, join(pluginDest, 'assets'));
    console.log(`  Assets${deployWord(mode)} -> ${join(pluginDest, 'assets')}`);
  }

  writeMcpJsonAndCodexManifest(pluginDest, 'codex-desktop', mode);

  // Register in personal marketplace (Codex discovers plugins from ~/.agents/plugins/marketplace.json)
  ensureCodexMarketplaceEntry();

  if (mode === 'install') {
    console.log('  \x1b[33m请到插件 → 个人 → HuaweiCloud DevKit → 安装\x1b[0m');

    // Clean up old install locations from pre-marketplace era. Neither
    // ~/.agents/skills nor ~/.agents/commands is removed wholesale: OpenClaw
    // installs share both, and user-authored content must survive —
    // devkit-owned skill names are reconciled precisely by
    // cleanupNativeDirs() at the command level. The plugin dir itself IS
    // OpenClaw's live install location (openclawPluginsDir is the same
    // path), so the cleanup fires only when no server payload lives there —
    // a live OpenClaw install must survive a codex-desktop install. Known
    // trade-off: a genuine pre-marketplace devkit install in that dir also
    // carried a payload and is now indistinguishable from a live OpenClaw
    // install, so it is deliberately left in place (destroying it is
    // irreversible; doctor's stale-tree check flags hollow trees); a
    // payload-less dir is unambiguous residue and still goes.
    const legacyPluginsDir = join(homedir(), '.agents', 'huaweicloud-plugins');
    if (existsSync(legacyPluginsDir) && !mcpServerInstalled(legacyPluginsDir)) {
      removeIfExists(legacyPluginsDir);
      console.log('  Cleaned old install location');
    }
  }

  installRuntimeDeps(pluginDest);
}

export function uninstallCodexDesktop(): void {
  const pluginDest = codexDesktopPluginsDir();
  // The whole plugin dir (server + safety + skills) is removed below; the
  // skills inside it are server data, not native agent skills.
  const cmdRemoved = removeHuaweiCommandsFrom(join(pluginDest, 'commands'));
  if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);

  backupDeltaFromMcpServersFile(pluginDest, 'codex-desktop');
  if (removeIfExists(pluginDest)) {
    console.log('  Removed MCP server and safety policy');
  }
  removeCodexMarketplaceEntry();

  // Clean up Codex plugin cache
  const cacheDir = join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'huaweicloud-devkit');
  if (removeIfExists(cacheDir)) {
    console.log('  Codex plugin cache cleaned');
  }

  // Clean up old config.toml section from pre-marketplace era. The sweep is
  // wholesale trunk behavior: EVERY [mcp_servers.huaweicloud-devkit…] table
  // goes, including user-authored subtables under our server name (a user
  // tools block vanishes with ours, and the doctor never sees it after the
  // uninstall). The devkit's own yield never lands in config.toml at all
  // (agents/codex-config.ts records why), so this pass removes legacy
  // server sections plus whatever users placed under that name — nothing
  // the current installer writes.
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (existsSync(configPath)) {
    const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
    const out: string[] = [];
    let skip = false;
    for (const line of lines) {
      if (/^\[mcp_servers\.huaweicloud-devkit(\]|\.)/.test(line)) {
        skip = true;
        continue;
      }
      if (skip && line.startsWith('[')) skip = false;
      if (!skip) out.push(line);
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    writeFileSync(configPath, out.join('\n') + (out.length > 0 ? '\n' : ''));
  }
}
