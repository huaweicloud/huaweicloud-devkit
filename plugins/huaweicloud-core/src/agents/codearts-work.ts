// The CodeArts Work (CodeArts Space) agent module, extracted from
// setup-cli.ts: the `mcp` + `command`/`environment` config dialect with
// peer-env inheritance for market-preset STS credentials.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { codeartsWorkMcpSettingsFile, codeartsWorkPluginsDir, codeartsWorkSkillsDir } from '../targets.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { applyPacksToEntry, packsEntryPending, warnPacksUserValueKept } from '../packs-policy.ts';
import { mergeCommandStyle, applyUserDelta, inheritPeerUserEnv } from '../mcp-config-merge.ts';
import { takeAgentDelta } from '../mcp-config-backup.ts';
import { printMcpConfigStatus, readJsonRecord, removeMcpServerEntry, writeMcpSettingsFile } from '../mcp-config-io.ts';
import { asRecord } from '../lib/as-record.ts';
import { stateDirNotice } from '../lib/state-dir.ts';
import {
  copyServerPayload,
  installRuntimeDeps,
  payloadStatusLines,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';

// Doctor: the CodeArts Work MCP-configured candidate — the mcp settings
// file's mcp.huaweicloud-devkit entry.
export function codeartsWorkDoctorMcpConfigured(): string | null {
  const codeartsWorkCfg = codeartsWorkMcpSettingsFile();
  if (!existsSync(codeartsWorkCfg)) return null;
  try {
    const cfg = asRecord(JSON.parse(readFileSync(codeartsWorkCfg, 'utf8')));
    if (cfg.mcp && asRecord(cfg.mcp)['huaweicloud-devkit']) return 'CodeArts Work';
  } catch {
    // corrupt CodeArts Work config skips this candidate — the probe continues
  }
  return null;
}

// --- CodeArts Work (CodeArts Space) ---

function registerCodeartsWorkMcp(): void {
  const configPath = codeartsWorkMcpSettingsFile();
  const mcpPath = join(codeartsWorkPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const environment: Record<string, string> = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) environment.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  const read = readJsonRecord(configPath);
  if (read.status === 'invalid') {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcp.huaweicloud-devkit" points to ${mcpPath}.`,
    );
    return;
  }
  const config: Record<string, unknown> = read.status === 'ok' ? read.value : {};
  if (read.status === 'ok') {
    const existing: unknown = asRecord(config.mcp)['huaweicloud-devkit'];
    if (existing) {
      // codearts-work uses `command` array + `environment` naming; adapt via mergeCommandStyle.
      const { entry, changed } = mergeCommandStyle(existing, { mcpPath });
      // packsEntryPending is pure; the kept-user-value warning fires exactly
      // once — here when the merge is a no-op, or in applyPacksToEntry below
      // when the merged entry is written (previously both sites warned).
      const packsCheck = packsEntryPending(existing, 'environment');
      if (!changed && !packsCheck.pending) {
        if (packsCheck.keptUserValue) {
          warnPacksUserValueKept('CodeArts Work', packsCheck.current ?? '', packsCheck.requested);
        }
        console.log(`  MCP config unchanged: ${configPath}`);
        return;
      }
      const merged: Record<string, unknown> = { ...entry };
      const existingEnv: unknown = asRecord(existing).environment;
      merged.environment = {
        ...(isPlainLocal(existingEnv) ? asRecord(existingEnv) : {}),
        HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local',
      };
      const mergedEnv = asRecord(merged.environment);
      if (hcloudBin && mergedEnv.HCLOUD_BIN === undefined) {
        mergedEnv.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
      }
      applyPacksToEntry(merged, 'environment', 'CodeArts Work');
      const mcpMap = asRecord(config.mcp);
      mcpMap['huaweicloud-devkit'] = merged;
      config.mcp = mcpMap;
      mkdirSync(dirname(configPath), { recursive: true });
      writeMcpSettingsFile(configPath, config);
      console.log(`  MCP config merged (user fields preserved): ${configPath}`);
      return;
    }
  }
  const mcpMap: Record<string, unknown> = asRecord(config.mcp);
  config.mcp = mcpMap;
  let entry = mergeCommandStyle(undefined, { mcpPath }).entry;
  entry.environment = { ...environment };
  // Inherit user-owned env (e.g. market-preset `huaweicloud-devkit_1` carrying the
  // user's temporary STS credentials) so a freshly installed key also has them.
  const peerEnv = inheritPeerUserEnv(mcpMap);
  if (peerEnv) entry.environment = { ...peerEnv, ...asRecord(entry.environment) };
  // Restore user fields saved by a previous uninstall (issue #615).
  const delta = takeAgentDelta('codearts-work');
  if (delta) entry = asRecord(applyUserDelta(entry, delta, 'command'));
  applyPacksToEntry(entry, 'environment', 'CodeArts Work');
  mcpMap['huaweicloud-devkit'] = entry;
  mkdirSync(dirname(configPath), { recursive: true });
  writeMcpSettingsFile(configPath, config);
  console.log(`  MCP config updated: ${configPath}`);
}

function isPlainLocal(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function deployCodeArtsWork(_mode: DeployMode): Promise<void> {
  const pluginDest = codeartsWorkPluginsDir();

  copyServerPayload(pluginDest);
  const stateNotice = stateDirNotice();
  if (stateNotice) console.log(`  [CodeArts Work] ${stateNotice}`);
  registerCodeartsWorkMcp();

  installRuntimeDeps(pluginDest);
}

export function uninstallCodeArtsWork(removeOwnedSkills: (dir: string) => number): void {
  const removed = removeOwnedSkills(codeartsWorkSkillsDir());
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  if (removeIfExists(codeartsWorkPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  removeMcpServerEntry(codeartsWorkMcpSettingsFile(), 'mcp', 'command', 'codearts-work');
}

export function codeartsWorkStatus(): void {
  payloadStatusLines(codeartsWorkPluginsDir());
  printMcpConfigStatus(codeartsWorkMcpSettingsFile(), 'mcp');
}

// Returns true when the config file was written, false when it was already correct.
