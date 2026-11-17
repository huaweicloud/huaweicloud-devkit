// The MCP-config writer family, extracted from setup-cli.ts: the
// read/parse/write/status IO for every agent-owned MCP config file. Entry
// semantics live in mcp-config-merge.ts, reinstall deltas in
// mcp-config-backup.ts, and the keptUserValue DEVKIT_PACKS contract in
// packs-policy.ts — this module owns the file shapes around them.
//
// Family members kept separate on purpose: updateOpenCodeConfig (jsonc
// tolerance + the skills-tree permission seam) and registerCodeartsWorkMcp
// (environment naming + peer-env inheritance) stay with their agents and
// consume readJsonRecord instead; writeMcpServersFile targets the
// devkit-owned .mcp.json inside the plugin dir, not an agent-owned config
// (an unparseable file is rewritten fresh, not skipped; fresh entries carry
// no timeout field; the delta restore is conditional).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { asRecord } from './lib/as-record.ts';
import { applyUserDelta, extractUserDelta, mergeArgsStyle } from './mcp-config-merge.ts';
import { saveAgentDelta, takeAgentDelta } from './mcp-config-backup.ts';
import { applyPacksToEntry } from './packs-policy.ts';
import { copyDir, deployWord, PLUGIN_ROOT, type DeployMode } from './install-payload.ts';
import { codexApprovalEnv, codexApprovalToolsBlock, CODEX_APPROVAL_MODE_ENV } from './agents/codex-config.ts';

// openclaw and codex-desktop both ship a .mcp.json plus the .codex-plugin
// manifest into their plugin dir — the codex-discoverable plugin-dir shape;
// the agentKey spells the delta-backup bucket in writeMcpServersFile. Moved
// here from agents/codex-desktop.ts: it wraps this module's own
// writeMcpServersFile, and both deploy faces import it from the writer
// family.
export function writeMcpJsonAndCodexManifest(pluginDest: string, agentKey: string, mode: DeployMode): void {
  const mcpServerAbsPath = join(pluginDest, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  writeMcpServersFile(pluginDest, mcpServerAbsPath, agentKey);
  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(pluginDest, '.codex-plugin'));
    console.log(`  Plugin Manifest${deployWord(mode)} -> ${join(pluginDest, '.codex-plugin')}`);
  }
}

// R5: write an MCP settings JSON file with least-privilege permissions
// (parent dir 0700, file 0600) so the platform-injected temporary credentials
// (HW_ACCESS_KEY/HW_SECRET_KEY/HW_SECURITY_TOKEN) are not world-readable.
export function writeMcpSettingsFile(configPath: string, config: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(configPath, 0o600);
    // Re-assert the parent dir mode too — later un-mode'd mkdirSync calls can
    // produce a broader default (e.g. 0775) on existing trees.
    chmodSync(dirname(configPath), 0o700);
  } catch {
    // best-effort; unsupported on some platforms
  }
}

// The one parse for agent-owned MCP config files: absent, unparseable, or a
// record. Every caller that previously hand-rolled existsSync + try/parse
// switches on this instead, so the parse outcome vocabulary has a single
// home.
export type JsonRecordRead =
  { status: 'absent' } | { status: 'invalid' } | { status: 'ok'; value: Record<string, unknown> };

export function readJsonRecord(configPath: string): JsonRecordRead {
  if (!existsSync(configPath)) return { status: 'absent' };
  try {
    return { status: 'ok', value: asRecord(JSON.parse(readFileSync(configPath, 'utf8'))) };
  } catch {
    return { status: 'invalid' };
  }
}

// The MCP-config line every directory-based status section reports.
// codearts-work spells its map 'mcp'; the rest use 'mcpServers'.
export function printMcpConfigStatus(configPath: string, mapKey: 'mcpServers' | 'mcp' = 'mcpServers'): void {
  const read = readJsonRecord(configPath);
  if (read.status === 'absent') return;
  if (read.status === 'invalid') {
    console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    return;
  }
  console.log(
    `  MCP config: ${asRecord(read.value[mapKey])['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
  );
}

// Read-merge-write for an agent-owned mcpServers config (atomcode, codearts,
// workbuddy). mcp-config-merge.ts owns the entry semantics, issue #615 delta
// restore owns reinstall recovery, and applyPacksToEntry owns the
// keptUserValue DEVKIT_PACKS contract.
export function ensureMcpServersConfig(options: {
  configPath: string;
  mcpPath: string;
  agentKey: string;
  label: string;
  env: Record<string, string>;
  enabledByDefault?: boolean;
}): boolean {
  const { configPath, mcpPath, agentKey, label, env } = options;
  let config: Record<string, unknown> = {};
  const read = readJsonRecord(configPath);
  if (read.status === 'invalid') {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`,
    );
    return false;
  }
  if (read.status === 'ok') {
    config = read.value;
    const existing: unknown = asRecord(config.mcpServers)['huaweicloud-devkit'];
    if (existing) {
      const { entry, changed } = mergeArgsStyle(existing, { mcpPath, env });
      const packsChanged = applyPacksToEntry(entry, 'env', label);
      if (!changed && !packsChanged) {
        console.log(`  MCP config unchanged: ${configPath}`);
        return false;
      }
      const servers = asRecord(config.mcpServers);
      servers['huaweicloud-devkit'] = entry;
      config.mcpServers = servers;
      mkdirSync(dirname(configPath), { recursive: true });
      writeMcpSettingsFile(configPath, config);
      console.log(`  MCP config merged (user fields preserved): ${configPath}`);
      return true;
    }
  }
  const servers: Record<string, unknown> = asRecord(config.mcpServers);
  config.mcpServers = servers;
  let entry = mergeArgsStyle(undefined, { mcpPath, env }).entry;
  if (options.enabledByDefault) entry.enabled = true;
  // Restore user fields saved by a previous uninstall (issue #615) before
  // the packs write so a delta-carried DEVKIT_PACKS counts as the current
  // value.
  const delta = takeAgentDelta(agentKey);
  if (delta) entry = asRecord(applyUserDelta(entry, delta, 'args'));
  applyPacksToEntry(entry, 'env', label);
  servers['huaweicloud-devkit'] = entry;
  mkdirSync(dirname(configPath), { recursive: true });
  writeMcpSettingsFile(configPath, config);
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

// Read-merge-write for pluginDir/.mcp.json (OpenClaw, Codex Desktop).
// Preserves user extra args/env; restores a prior uninstall's backup on fresh
// install (issue #615). Kept separate from ensureMcpServersConfig because its
// target is the devkit-owned file inside the plugin dir, not an agent-owned
// config: an unparseable file is rewritten fresh (not skipped), fresh entries
// carry no timeout field, and the delta restore is conditional.
export function writeMcpServersFile(pluginDest: string, mcpPath: string, agentKey: string): void {
  const configPath = join(pluginDest, '.mcp.json');
  const read = readJsonRecord(configPath);
  const configRecord: Record<string, unknown> | undefined = read.status === 'ok' ? read.value : undefined;
  const existing: unknown = configRecord ? asRecord(configRecord.mcpServers)['huaweicloud-devkit'] : undefined;
  const { entry, changed } = mergeArgsStyle(existing, {
    mcpPath,
    env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' },
    defaultTimeout: null,
  });
  let finalEntry: Record<string, unknown> = entry;
  if (!existing) {
    // Restore user fields saved by a previous uninstall (issue #615) before
    // the packs write so a delta-carried DEVKIT_PACKS counts as the current value.
    const delta = takeAgentDelta(agentKey);
    if (delta) finalEntry = asRecord(applyUserDelta(entry, delta, 'args'));
  }
  const packsChanged = applyPacksToEntry(finalEntry, 'env', agentKey === 'openclaw' ? 'OpenClaw' : 'Codex Desktop');
  // The codex client yield (PR-5): the per-tool approve blocks inside the
  // devkit-owned server entry — codex reads them from the plugin-provided
  // server definition (the config.toml route is refused by codex's own
  // bootstrap validation when the implied server has no transport; see
  // agents/codex-config.ts). OpenClaw shares this writer but is not codex,
  // so its .mcp.json stays block-free. The block is ours wholesale — the
  // file is devkit-owned and regenerated — and a drift (an older deploy's
  // missing or hand-stripped tools map) counts as a change so the next
  // update heals it, same as the packs write above.
  let toolsChanged = false;
  let envChanged = false;
  if (agentKey !== 'openclaw') {
    const wanted = codexApprovalToolsBlock();
    toolsChanged = JSON.stringify(finalEntry.tools) !== JSON.stringify(wanted);
    if (toolsChanged) finalEntry.tools = wanted;
    // The ask-mode env half rides the same codex-only condition as the tools
    // block (openclaw is not codex and stays both block- and env-free). The
    // env is ours wholesale too — same doctrine, same drift healing: a stale
    // or hand-edited copy is a change, so the next update restores it.
    const entryEnv = asRecord(finalEntry.env);
    if (entryEnv.DEVKIT_APPROVAL_MODE !== CODEX_APPROVAL_MODE_ENV) {
      finalEntry.env = { ...entryEnv, ...codexApprovalEnv() };
      envChanged = true;
    }
  }
  if (existing && !changed && !packsChanged && !toolsChanged && !envChanged) {
    console.log(`  MCP Config unchanged: ${configPath}`);
    return;
  }
  const next: Record<string, unknown> = configRecord ? { ...configRecord } : {};
  const nextServers: Record<string, unknown> = {
    ...asRecord(configRecord ? configRecord.mcpServers : undefined),
    'huaweicloud-devkit': finalEntry,
  };
  next.mcpServers = nextServers;
  writeMcpSettingsFile(configPath, next);
  console.log(`  MCP Config -> ${configPath}`);
}

// Back up the user delta from a pluginDir/.mcp.json before the directory is
// removed (issue #615).
export function backupDeltaFromMcpServersFile(pluginDest: string, agentKey: string): void {
  const configPath = join(pluginDest, '.mcp.json');
  const read = readJsonRecord(configPath);
  if (read.status !== 'ok') return;
  const delta = extractUserDelta(asRecord(read.value.mcpServers)['huaweicloud-devkit'], 'args');
  if (delta) saveAgentDelta(agentKey, delta);
}

// Remove the huaweicloud-devkit entry from an agent's MCP config map,
// backing up user-added fields first (issue #615). Shared by the
// codearts/codearts-work/workbuddy/atomcode uninstalls; the map key and the
// delta key spell the per-agent config dialect ('mcp' + 'command' for
// codearts-work, 'mcpServers' + 'args' elsewhere).
export function removeMcpServerEntry(
  configPath: string,
  mapKey: 'mcpServers' | 'mcp',
  deltaKey: 'args' | 'command',
  agentKey: string,
): void {
  const read = readJsonRecord(configPath);
  if (read.status === 'absent') return;
  // a corrupt config leaves the empty default — no recognizable entry to clean
  const config: Record<string, unknown> = read.status === 'ok' ? read.value : {};
  const servers = asRecord(config[mapKey]);
  if (!servers['huaweicloud-devkit']) return;
  const delta = extractUserDelta(servers['huaweicloud-devkit'], deltaKey);
  if (delta) saveAgentDelta(agentKey, delta);
  delete servers['huaweicloud-devkit'];
  config[mapKey] = servers;
  if (Object.keys(servers).length === 0) delete config[mapKey];
  writeMcpSettingsFile(configPath, config);
  console.log(`  MCP config cleaned: ${configPath}`);
}
