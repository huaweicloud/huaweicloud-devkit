// Pure helpers for merging HuaweiCloud DevKit MCP config entries without
// dropping user-customized fields (extra command args, env, timeout, enabled).
// Program-owned fields (the node executable + mcp-server.mjs path, required env
// keys) are corrected by the installer; everything else belongs to the user.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Merge env maps: our required keys are only set when absent; user-set values
// always win. Returns null when nothing needs to change.
function mergeEnv(
  userEnv: Record<string, unknown> = {},
  requiredEnv: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const merged = { ...userEnv };
  let changed = false;
  for (const [key, value] of Object.entries(requiredEnv)) {
    if (merged[key] === undefined) {
      merged[key] = value;
      changed = true;
    }
  }
  if (!changed && sameJson(merged, userEnv)) return null;
  return merged;
}

function withDefaultTimeout(
  entry: Record<string, unknown>,
  defaultTimeout: number | null | undefined,
): Record<string, unknown> {
  // Pass null explicitly to omit the timeout field (defaults only apply to undefined).
  if (defaultTimeout) entry.timeout = defaultTimeout;
  return entry;
}

interface CommandStyleOptions {
  mcpPath?: string;
  defaultTimeout?: number | null;
}

interface ArgsStyleOptions {
  mcpPath?: string;
  env?: Record<string, unknown>;
  defaultTimeout?: number | null;
}

export interface MergeResult {
  entry: Record<string, unknown>;
  changed: boolean;
}

// OpenCode style entry: { type, command: ['node', mcpPath, ...userArgs], ... }
export function mergeCommandStyle(
  existing: unknown,
  { mcpPath, defaultTimeout = 300000 }: CommandStyleOptions = {},
): MergeResult {
  if (!isPlainObject(existing)) {
    return {
      entry: withDefaultTimeout({ type: 'local', command: ['node', mcpPath], enabled: true }, defaultTimeout),
      changed: true,
    };
  }
  const commandIsNodeStyle = Array.isArray(existing.command) && existing.command[0] === 'node';
  if (!commandIsNodeStyle) {
    // Foreign wrapper entry: keep current overwrite behavior.
    return {
      entry: withDefaultTimeout({ type: 'local', command: ['node', mcpPath], enabled: true }, defaultTimeout),
      changed: true,
    };
  }
  const command = Array.isArray(existing.command) ? existing.command : [];
  const merged: Record<string, unknown> = {
    ...existing,
    type: 'local',
    command: ['node', mcpPath, ...command.slice(2)],
  };
  if (merged.timeout === undefined && defaultTimeout) merged.timeout = defaultTimeout;
  if (merged.enabled === undefined) merged.enabled = true;
  return { entry: merged, changed: !sameJson(merged, existing) };
}

// WorkBuddy/AtomCode/CodeArts style entry: { command: 'node', args: [mcpPath, ...userArgs], env, ... }
export function mergeArgsStyle(
  existing: unknown,
  { mcpPath, env = {}, defaultTimeout = 300000 }: ArgsStyleOptions = {},
): MergeResult {
  if (!isPlainObject(existing)) {
    return {
      entry: withDefaultTimeout({ command: 'node', args: [mcpPath], env: { ...env } }, defaultTimeout),
      changed: true,
    };
  }
  const commandIsNodeStyle = existing.command === 'node';
  if (!commandIsNodeStyle) {
    return {
      entry: withDefaultTimeout({ command: 'node', args: [mcpPath], env: { ...env } }, defaultTimeout),
      changed: true,
    };
  }
  const merged: Record<string, unknown> = {
    ...existing,
    command: 'node',
    args: [mcpPath, ...(Array.isArray(existing.args) ? existing.args.slice(1) : [])],
  };
  const envMerged = mergeEnv(isPlainObject(existing.env) ? existing.env : {}, env);
  if (envMerged) merged.env = envMerged;
  if (merged.timeout === undefined && defaultTimeout) merged.timeout = defaultTimeout;
  return { entry: merged, changed: !sameJson(merged, existing) };
}

// Codex Desktop / OpenClaw .mcp.json style: { mcpServers: { 'huaweicloud-devkit': entry } }
// Fresh entries keep the historical shape (no timeout field); user-set timeouts are preserved.
export function mergeMcpServersFile(
  config: unknown,
  { mcpPath, env = {} }: { mcpPath?: string; env?: Record<string, unknown> } = {},
): MergeResult & { config: Record<string, unknown> } {
  const existing =
    isPlainObject(config) && isPlainObject(config.mcpServers) ? config.mcpServers['huaweicloud-devkit'] : undefined;
  const { entry, changed } = mergeArgsStyle(existing, { mcpPath, env, defaultTimeout: null });
  const next: Record<string, unknown> = isPlainObject(config) ? { ...config } : {};
  const servers = isPlainObject(config) && isPlainObject(config.mcpServers) ? config.mcpServers : {};
  next.mcpServers = { ...servers, 'huaweicloud-devkit': entry };
  return { entry, config: next, changed: changed || !isPlainObject(config) || !existing };
}

// Env keys the installer manages itself (recomputed on every install) — never
// treated as user assets for backup purposes.
const REQUIRED_ENV_KEYS = new Set(['HUAWEICLOUD_AGENT_TOOLKIT_MODE', 'HCLOUD_BIN']);

// Extract the user-owned delta of an entry for backup before uninstall removes it.
export function extractUserDelta(entry: unknown, style: string): Record<string, unknown> | null {
  if (!isPlainObject(entry)) return null;
  const delta: Record<string, unknown> = {};
  if (style === 'command') {
    if (Array.isArray(entry.command) && entry.command.length > 2) delta.commandExtra = entry.command.slice(2);
  } else if (style === 'args') {
    if (Array.isArray(entry.args) && entry.args.length > 1) delta.argsExtra = entry.args.slice(1);
  } else {
    return null;
  }
  if (isPlainObject(entry.env)) {
    const userEnv = Object.fromEntries(Object.entries(entry.env).filter(([key]) => !REQUIRED_ENV_KEYS.has(key)));
    if (Object.keys(userEnv).length > 0) delta.env = userEnv;
  }
  if (entry.timeout !== undefined && entry.timeout !== 300000) delta.timeout = entry.timeout;
  if (entry.enabled === false) delta.enabled = false;
  return Object.keys(delta).length > 0 ? delta : null;
}

// Apply a previously saved delta onto a freshly written default entry.
export function applyUserDelta(entry: unknown, delta: unknown, style: string): unknown {
  if (!isPlainObject(entry) || !isPlainObject(delta)) return entry;
  const merged: Record<string, unknown> = { ...entry };
  if (style === 'command' && Array.isArray(delta.commandExtra)) {
    const base = Array.isArray(entry.command) ? entry.command : [];
    merged.command = [...base, ...delta.commandExtra];
  } else if (style === 'args' && Array.isArray(delta.argsExtra)) {
    const base = Array.isArray(entry.args) ? entry.args : [];
    merged.args = [...base, ...delta.argsExtra];
  }
  if (isPlainObject(delta.env)) {
    merged.env = { ...(isPlainObject(entry.env) ? entry.env : {}), ...delta.env };
  }
  if (delta.timeout !== undefined) merged.timeout = delta.timeout;
  if (delta.enabled === false) merged.enabled = false;
  return merged;
}

// Collect user-owned environment variables from peer DevKit server entries in the
// same MCP map (e.g. market-preset keys like `huaweicloud-devkit_1` that carry the
// user's temporary STS credentials HW_ACCESS_KEY / HW_SECRET_KEY / HW_SECURITY_TOKEN).
// When the installer writes a NEW `huaweicloud-devkit` entry these must be inherited
// so the freshly installed key also has the user's credentials (the CodeArts Work
// UI never surfaces them; they live only in mcp_settings.json).
export function inheritPeerUserEnv(mcpMap: unknown): Record<string, unknown> | null {
  if (!isPlainObject(mcpMap)) return null;
  const collected: Record<string, string> = {};
  for (const [key, entry] of Object.entries(mcpMap)) {
    if (key === 'huaweicloud-devkit') continue;
    if (!/^huaweicloud-devkit(?:_|$)/i.test(key) && key !== 'HuaweiCloud DevKit') continue;
    let env: Record<string, unknown> | null = null;
    if (isPlainObject(entry)) {
      if (isPlainObject(entry.environment)) env = entry.environment;
      else if (isPlainObject(entry.env)) env = entry.env;
    }
    if (!env) continue;
    for (const [k, v] of Object.entries(env)) {
      if (REQUIRED_ENV_KEYS.has(k)) continue;
      if (typeof v !== 'string' || v === '') continue;
      if (!(k in collected)) collected[k] = v;
    }
  }
  return Object.keys(collected).length > 0 ? collected : null;
}
