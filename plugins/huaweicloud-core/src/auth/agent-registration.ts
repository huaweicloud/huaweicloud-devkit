import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const SUPPORTED_AGENT_TARGETS: string[] = [
  'opencode',
  'codex',
  'codex-desktop',
  'codearts',
  'codearts-work',
  'workbuddy',
  'dsh',
  'officeace',
  'hermes',
  'openclaw',
  'atomcode',
];

function baseHome(): string {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

function opencodeConfigFile(): string {
  const jsonc = join(baseHome(), '.config', 'opencode', 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(baseHome(), '.config', 'opencode', 'opencode.json');
}

function readJsonSafe(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function opencodeRegistered(): boolean {
  const path = opencodeConfigFile();
  const cfg = asRecord(readJsonSafe(path));
  return Boolean(asRecord(cfg.mcp)['huaweicloud-devkit']);
}

function codexDesktopRegistered(): boolean {
  const path = join(baseHome(), '.codex', 'config.toml');
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes('[mcp_servers.huaweicloud-devkit]');
  } catch {
    return false;
  }
}

function codexCliRegistered(): boolean {
  try {
    const r = spawnSync('codex', ['plugin', 'list'], {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 10000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return out.includes('huaweicloud-core');
  } catch {
    return false;
  }
}

function codeartsRegistered(): boolean {
  const paths = [
    join(baseHome(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
    join(process.cwd(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
  ];
  return paths.some((path) => {
    const cfg = asRecord(readJsonSafe(path));
    return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
  });
}

function codeartsWorkRegistered(): boolean {
  const path = join(baseHome(), '.codeartswork', 'mcp', 'mcp_settings.json');
  const cfg = asRecord(readJsonSafe(path));
  return Boolean(asRecord(cfg.mcp)['huaweicloud-devkit']);
}

function workbuddyRegistered(): boolean {
  const cfg = asRecord(readJsonSafe(join(baseHome(), '.workbuddy', 'mcp.json')));
  return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
}

function dshRoot(): string {
  return process.env.DSH_HOME || join(baseHome(), '.dsh');
}

function dshRegistered(): boolean {
  const patchPath = join(dshRoot(), 'profiles', 'web', 'cordis.patch.yml');
  if (!existsSync(patchPath)) return false;
  try {
    const patch = readFileSync(patchPath, 'utf8');
    return (
      (patch.includes('id: huaweicloud-devkit') || patch.includes('id: mcp-huaweicloud')) &&
      patch.includes('@deepseek-ai/dsh-mcp-client') &&
      patch.includes('serverName: huaweicloud')
    );
  } catch {
    return false;
  }
}

function readOfficeaceRegistryInstallDir(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\OfficeAce\\OfficeAce', '/v', 'InstallDir'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status === 0) {
      const m = r.stdout.match(/InstallDir\s+REG_SZ\s+(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return null;
}

function officeaceCapabilitiesDir(): string | null {
  const configRoot = process.env.OFFICE_CLAW_CONFIG_ROOT;
  if (configRoot && existsSync(join(configRoot, 'capabilities.json'))) return configRoot;
  const regDir = readOfficeaceRegistryInstallDir();
  if (regDir) {
    const dir = join(regDir, '.office-claw');
    if (existsSync(join(dir, 'capabilities.json'))) return dir;
  }
  if (process.platform === 'win32') {
    const bases: Array<string | undefined> = [process.env.ProgramFiles, 'C:\\Program Files', 'D:\\Program Files'];
    if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs'));
    for (const base of bases) {
      if (!base) continue;
      const dir = join(base, 'OfficeAce', '.office-claw');
      if (existsSync(join(dir, 'capabilities.json'))) return dir;
    }
  }
  return null;
}

function officeaceCapabilitiesDirSafe(): string {
  return officeaceCapabilitiesDir() || join(baseHome(), '.office-claw');
}

function officeaceSqlitePath(): string {
  const capDir = officeaceCapabilitiesDirSafe();
  return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}

// node:sqlite is a runtime-only builtin loaded through createRequire; only the
// DatabaseSync constructor this module calls is modeled.
interface SqliteStatement {
  get: () => unknown;
}

interface SqliteDatabase {
  prepare: (_sql: string) => SqliteStatement;
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (_path: string, _options?: { readonly?: boolean }) => SqliteDatabase;
}

function toSqliteModule(value: unknown): SqliteModule | null {
  if (!value || typeof value !== 'object') return null;
  const ctor = (value as { DatabaseSync?: unknown }).DatabaseSync;
  return typeof ctor === 'function' ? (value as SqliteModule) : null;
}

function officeaceRegistered(): boolean {
  let hasMcp = false;
  const dbPath = officeaceSqlitePath();
  if (existsSync(dbPath)) {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor >= 22) {
      try {
        const sqlite = toSqliteModule(createRequire(import.meta.url)('node:sqlite'));
        if (sqlite) {
          const db = new sqlite.DatabaseSync(dbPath, { readonly: true });
          const row = db.prepare("SELECT enabled FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
          db.close();
          hasMcp = Boolean(asRecord(row).enabled);
        }
      } catch {}
    }
  }

  const capFile = join(officeaceCapabilitiesDirSafe(), 'capabilities.json');
  const cfg = asRecord(readJsonSafe(capFile));
  const capabilities = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
  const hasSkills = capabilities.some((c) => {
    const cap = asRecord(c);
    return cap.id === 'huaweicloud-core' && cap.type === 'skill';
  });

  return hasMcp || hasSkills;
}

function atomcodeHome(): string {
  return process.env.ATOMCODE_HOME || join(baseHome(), '.atomcode');
}

function atomcodeRegistered(): boolean {
  const cfg = asRecord(readJsonSafe(join(atomcodeHome(), 'mcp.json')));
  return Boolean(asRecord(cfg.mcpServers)['huaweicloud-devkit']);
}

function openclawMcpConfigured(cfg: unknown): boolean {
  if (!cfg) return false;
  const record = asRecord(cfg);
  if (asRecord(record.mcpServers)['huaweicloud-devkit']) return true;
  if (asRecord(asRecord(record.mcp).servers)['huaweicloud-devkit']) return true;
  return false;
}

function openclawRegistered(): boolean {
  const pluginCfg = readJsonSafe(join(baseHome(), '.agents', 'huaweicloud-plugins', '.mcp.json'));
  if (openclawMcpConfigured(pluginCfg)) return true;
  const nativeCfg = readJsonSafe(join(baseHome(), '.openclaw', 'openclaw.json'));
  return openclawMcpConfigured(nativeCfg);
}

function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  // Hermes on Windows stores under LOCALAPPDATA, not ~/.hermes
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'hermes');
  }
  return join(baseHome(), '.hermes');
}

function hermesRegistered(): boolean {
  const configPath = join(hermesHome(), 'config.yaml');
  if (!existsSync(configPath)) return false;
  try {
    const content = readFileSync(configPath, 'utf8');
    return content.includes('mcp_servers:') && content.includes('huaweicloud-devkit');
  } catch {
    return false;
  }
}

export interface AgentRegistrationStatus {
  configured: boolean;
}

export interface AgentRegistrationResult {
  target: string;
  agents: Record<string, AgentRegistrationStatus>;
}

export function getAgentRegistrationStatuses(target = 'all'): AgentRegistrationResult {
  const requested = target === 'all' ? SUPPORTED_AGENT_TARGETS : [target];
  const result: AgentRegistrationResult = { target, agents: {} };
  for (const agent of requested) {
    let configured = false;
    if (agent === 'opencode') configured = opencodeRegistered();
    if (agent === 'codex-desktop') configured = codexDesktopRegistered();
    if (agent === 'codex') configured = codexCliRegistered();
    if (agent === 'codearts') configured = codeartsRegistered();
    if (agent === 'codearts-work') configured = codeartsWorkRegistered();
    if (agent === 'workbuddy') configured = workbuddyRegistered();
    if (agent === 'dsh') configured = dshRegistered();
    if (agent === 'officeace') configured = officeaceRegistered();
    if (agent === 'hermes') configured = hermesRegistered();
    if (agent === 'openclaw') configured = openclawRegistered();
    if (agent === 'atomcode') configured = atomcodeRegistered();
    result.agents[agent] = { configured };
  }
  return result;
}
