// Backup/restore of user-customized MCP config fields across uninstall/reinstall (issue #615).
// Uninstall saves the user delta keyed by agent; a later install/update consumes and applies it.
//
// Residual semantics: deltas are namespaced per agent and only that agent's
// next install/update consumes them (take-once). If the user never reinstalls
// an agent, its delta simply stays in the backup file — this is expected and
// harmless (no cross-agent contamination). `uninstall --target all` purges
// the whole file explicitly.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

type BackupMap = Record<string, unknown>;

export function mcpBackupFilePath(base: string = process.env.HUAWEICLOUD_HOME || homedir()): string {
  return join(base, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
}

function readBackup(file: string): BackupMap {
  if (!existsSync(file)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as BackupMap) : {};
  } catch {
    return {};
  }
}

export function readAgentDelta(agentKey: string, file: string = mcpBackupFilePath()): Record<string, unknown> | null {
  const delta = readBackup(file)[agentKey];
  return delta && typeof delta === 'object' ? (delta as Record<string, unknown>) : null;
}

export function saveAgentDelta(agentKey: string, delta: unknown, file: string = mcpBackupFilePath()): boolean {
  if (!agentKey || !delta || typeof delta !== 'object') return false;
  const backup = readBackup(file);
  backup[agentKey] = { ...delta, savedAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(backup, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Consume the delta for an agent: returns it and removes it from the backup file.
export function takeAgentDelta(agentKey: string, file: string = mcpBackupFilePath()): Record<string, unknown> | null {
  const delta = readAgentDelta(agentKey, file);
  if (!delta) return null;
  const backup = readBackup(file);
  delete backup[agentKey];
  try {
    if (Object.keys(backup).length === 0) {
      rmSync(file, { force: true });
    } else {
      writeFileSync(file, JSON.stringify(backup, null, 2));
    }
  } catch {}
  return delta;
}

export function purgeBackup(file: string = mcpBackupFilePath()): boolean {
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
