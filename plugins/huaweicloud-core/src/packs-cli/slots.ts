// The packs slot table, extracted from setup-cli.ts: one entry per
// installable agent target that has an MCP config to read DEVKIT_PACKS
// from — where the config lives, which env spelling it reads, how to
// surgically write the DEVKIT_PACKS key. Doctor's pack status display, the
// effective pack union, the `packs` command family, and install-time
// provisioning all derive from this table, so the read and write paths can
// never disagree. The writers live in packs-cli/writers.ts, the union +
// renderers in packs-cli/report.ts, the doctor face in packs-cli/doctor.ts,
// and the command bodies in packs-cli/commands.ts and
// packs-cli/write-command.ts.

import { join } from 'node:path';

import {
  atomcodeMcpConfigFile,
  atomcodePluginsDir,
  codeartsMcpSettingsFile,
  codeartsPluginsDir,
  codeartsWorkMcpSettingsFile,
  codeartsWorkPluginsDir,
  codexDesktopPluginsDir,
  dshPatchFile,
  dshPluginsDir,
  hermesPluginsDir,
  opencodeConfigFile,
  opencodePluginsDir,
  openclawPluginsDir,
  workbuddyMcpConfigFile,
  workbuddyPluginsDir,
} from '../targets.ts';
import { readDevkitPacksFromJson, readDevkitPacksFromYaml } from '../packs-policy.ts';
import { readHermesDevkitPacks, writeHermesMcpConfigResult } from '../agents/hermes-config.ts';
import { readOfficeaceDevkitPacks, writeDevkitPacksInOfficeace } from '../agents/officeace-sqlite.ts';
import { officeacePluginsDir } from '../officeace-paths.ts';
import { mcpServerInstalled } from '../install-payload.ts';
import { writeCodeartsDevkitPacks, writeDevkitPacksInDshPatch, writeDevkitPacksInJson } from './writers.ts';

export type PackWriteResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'parse-failed' | 'bundle-owned' | 'not-installed' | 'refused'; detail: string };

export interface PackSlot {
  /** SUPPORTED_AGENT_TARGETS member; codex has no slot (display-only). */
  id: string;
  /** Doctor's per-target label spelling. */
  label: string;
  installed(): boolean;
  /** Raw DEVKIT_PACKS value; null when the key (or its file) is absent. */
  read(): string | null;
  write(_next: string | null): PackWriteResult;
}

export const PACK_SLOTS: PackSlot[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    installed: () => mcpServerInstalled(opencodePluginsDir()),
    read: () => readDevkitPacksFromJson(opencodeConfigFile(), 'mcp'),
    write: (next) => writeDevkitPacksInJson(opencodeConfigFile(), 'mcp', 'environment', next),
  },
  {
    id: 'codex-desktop',
    label: 'Codex Desktop',
    installed: () => mcpServerInstalled(codexDesktopPluginsDir()),
    read: () => readDevkitPacksFromJson(join(codexDesktopPluginsDir(), '.mcp.json'), 'mcpServers'),
    write: (next) => writeDevkitPacksInJson(join(codexDesktopPluginsDir(), '.mcp.json'), 'mcpServers', 'env', next),
  },
  {
    id: 'codearts',
    label: 'CodeArts',
    installed: () => mcpServerInstalled(codeartsPluginsDir()),
    read: () => readDevkitPacksFromJson(codeartsMcpSettingsFile(), 'mcpServers'),
    write: (next) => writeCodeartsDevkitPacks(next),
  },
  {
    id: 'codearts-work',
    label: 'CodeArts Work',
    installed: () => mcpServerInstalled(codeartsWorkPluginsDir()),
    read: () => readDevkitPacksFromJson(codeartsWorkMcpSettingsFile(), 'mcp'),
    write: (next) => writeDevkitPacksInJson(codeartsWorkMcpSettingsFile(), 'mcp', 'environment', next),
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    installed: () => mcpServerInstalled(workbuddyPluginsDir()),
    read: () => readDevkitPacksFromJson(workbuddyMcpConfigFile(), 'mcpServers'),
    write: (next) => writeDevkitPacksInJson(workbuddyMcpConfigFile(), 'mcpServers', 'env', next),
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    installed: () => mcpServerInstalled(openclawPluginsDir()),
    read: () => readDevkitPacksFromJson(join(openclawPluginsDir(), '.mcp.json'), 'mcpServers'),
    write: (next) => writeDevkitPacksInJson(join(openclawPluginsDir(), '.mcp.json'), 'mcpServers', 'env', next),
  },
  {
    id: 'atomcode',
    label: 'AtomCode',
    installed: () => mcpServerInstalled(atomcodePluginsDir()),
    read: () => readDevkitPacksFromJson(atomcodeMcpConfigFile(), 'mcpServers'),
    write: (next) => writeDevkitPacksInJson(atomcodeMcpConfigFile(), 'mcpServers', 'env', next),
  },
  {
    id: 'dsh',
    label: 'DSH',
    installed: () => mcpServerInstalled(dshPluginsDir()),
    read: () => readDevkitPacksFromYaml(dshPatchFile()),
    write: (next) => writeDevkitPacksInDshPatch(next),
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    installed: () => mcpServerInstalled(hermesPluginsDir()),
    read: () => readHermesDevkitPacks(),
    write: (next) => {
      // A refused write (non-mergeable config shape) must surface as a
      // failure, not report "unchanged" with a green exit code.
      const result = writeHermesMcpConfigResult(next);
      return result.refused !== null
        ? { ok: false as const, reason: 'refused' as const, detail: result.refused }
        : { ok: true as const, changed: result.changed };
    },
  },
  {
    id: 'officeace',
    label: 'OfficeAce',
    installed: () => mcpServerInstalled(officeacePluginsDir()),
    read: () => readOfficeaceDevkitPacks(),
    write: (next) => writeDevkitPacksInOfficeace(next),
  },
];

// Reader-backed pack status: one entry per installable agent target that
// has an MCP config to read DEVKIT_PACKS from. Shared by doctor (per-target
// pack status) and install-time provisioning (the effective pack union);
// derived from PACK_SLOTS so it cannot drift from the write path.
export function packStatusReaders(): Array<{ label: string; installed: boolean; read: () => string | null }> {
  return PACK_SLOTS.map((slot) => ({ label: slot.label, installed: slot.installed(), read: () => slot.read() }));
}
