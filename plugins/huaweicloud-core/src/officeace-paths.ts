// Shared OfficeAce config-root resolution used by both the installer
// (setup-cli.ts) and the MCP runtime (tools.ts), so skills are installed
// to and read from the same location (#559).
//
// OfficeAce exposes no API for the plugin to query the current user or
// install directory, so the root is located by probing. The probe result is
// persisted in a marker file so a non-standard directory (entered via prompt,
// whose OFFICE_CLAW_CONFIG_ROOT env does not survive across processes) is
// still found by later uninstall/update runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

function markerPath(): string {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'devkit-officeace-root.json');
}

function sqliteSibling(dir: string): string {
  return join(resolve(dir, '..'), 'data', 'mcp-connectors.sqlite');
}

// A directory is a usable OfficeAce config root when it exists and carries
// OfficeAce evidence — capabilities.json, the connector DB, or DevKit's own
// installed artifacts. Deliberately more lenient than "capabilities.json must
// exist" so uninstall/update still find the root after it was removed.
export function isUsableOfficeaceRoot(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  return (
    existsSync(join(dir, 'capabilities.json')) ||
    existsSync(sqliteSibling(dir)) ||
    existsSync(join(dir, 'skills')) ||
    existsSync(join(dir, 'huaweicloud-plugins'))
  );
}

export function readOfficeaceRootMarker(): string | null {
  try {
    const marker: { root?: unknown } = JSON.parse(readFileSync(markerPath(), 'utf8'));
    return typeof marker.root === 'string' && isUsableOfficeaceRoot(marker.root) ? marker.root : null;
  } catch {
    return null;
  }
}

export function writeOfficeaceRootMarker(root: string): void {
  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2));
  } catch {}
}
