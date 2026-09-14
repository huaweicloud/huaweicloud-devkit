// Pure helpers for merging HuaweiCloud DevKit MCP config entries without
// dropping user-customized fields (extra command args, env, timeout, enabled).
// Program-owned fields (the node executable + mcp-server.mjs path, required env
// keys) are corrected by the installer; everything else belongs to the user.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Merge env maps: our required keys are only set when absent; user-set values
// always win. Returns null when nothing needs to change.
function mergeEnv(userEnv = {}, requiredEnv = {}) {
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

function withDefaultTimeout(entry, defaultTimeout) {
  // Pass null explicitly to omit the timeout field (defaults only apply to undefined).
  if (defaultTimeout) entry.timeout = defaultTimeout;
  return entry;
}

// OpenCode style entry: { type, command: ['node', mcpPath, ...userArgs], ... }
export function mergeCommandStyle(existing, { mcpPath, defaultTimeout = 300000 } = {}) {
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
  const merged = { ...existing, type: 'local', command: ['node', mcpPath, ...existing.command.slice(2)] };
  if (merged.timeout === undefined && defaultTimeout) merged.timeout = defaultTimeout;
  if (merged.enabled === undefined) merged.enabled = true;
  return { entry: merged, changed: !sameJson(merged, existing) };
}

// WorkBuddy/AtomCode/CodeArts style entry: { command: 'node', args: [mcpPath, ...userArgs], env, ... }
export function mergeArgsStyle(existing, { mcpPath, env = {}, defaultTimeout = 300000 } = {}) {
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
  const merged = {
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
export function mergeMcpServersFile(config, { mcpPath, env = {} } = {}) {
  const existing = isPlainObject(config) ? config.mcpServers?.['huaweicloud-devkit'] : undefined;
  const { entry, changed } = mergeArgsStyle(existing, { mcpPath, env, defaultTimeout: null });
  const next = isPlainObject(config) ? { ...config } : {};
  next.mcpServers = { ...(isPlainObject(config) ? config.mcpServers : {}), 'huaweicloud-devkit': entry };
  return { entry, config: next, changed: changed || !isPlainObject(config) || !existing };
}

// Env keys the installer manages itself (recomputed on every install) — never
// treated as user assets for backup purposes.
const REQUIRED_ENV_KEYS = new Set(['HUAWEICLOUD_AGENT_TOOLKIT_MODE', 'HCLOUD_BIN']);

// Extract the user-owned delta of an entry for backup before uninstall removes it.
export function extractUserDelta(entry, style) {
  if (!isPlainObject(entry)) return null;
  const delta = {};
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
export function applyUserDelta(entry, delta, style) {
  if (!isPlainObject(entry) || !isPlainObject(delta)) return entry;
  const merged = { ...entry };
  if (style === 'command' && Array.isArray(delta.commandExtra)) {
    merged.command = [...entry.command, ...delta.commandExtra];
  } else if (style === 'args' && Array.isArray(delta.argsExtra)) {
    merged.args = [...entry.args, ...delta.argsExtra];
  }
  if (isPlainObject(delta.env)) {
    merged.env = { ...(isPlainObject(entry.env) ? entry.env : {}), ...delta.env };
  }
  if (delta.timeout !== undefined) merged.timeout = delta.timeout;
  if (delta.enabled === false) merged.enabled = false;
  return merged;
}
