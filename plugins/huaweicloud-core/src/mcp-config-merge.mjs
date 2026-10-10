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

// OpenCode style entry: { type, command: ['node', mcpPath, ...userArgs], ... }.
// era 'v1' writes the legacy shape (enabled + flat timeout); era 'v2' writes the
// native V2 shape (no flat `enabled`/`timeout` — V2 uses `disabled` and a nested
// timeout object, so both are left to OpenCode defaults unless the user set them).
export function mergeCommandStyle(existing, { mcpPath, defaultTimeout = 300000, era = 'v1' } = {}) {
  const v2 = era === 'v2';
  const freshDefault = () =>
    v2
      ? { type: 'local', command: ['node', mcpPath] }
      : withDefaultTimeout({ type: 'local', command: ['node', mcpPath], enabled: true }, defaultTimeout);

  if (!isPlainObject(existing)) {
    return { entry: freshDefault(), changed: true };
  }
  const commandIsNodeStyle = Array.isArray(existing.command) && existing.command[0] === 'node';
  if (!commandIsNodeStyle) {
    // Foreign wrapper entry: keep current overwrite behavior.
    return { entry: freshDefault(), changed: true };
  }
  const merged = { ...existing, type: 'local', command: ['node', mcpPath, ...existing.command.slice(2)] };
  if (v2) {
    // Native V2 shape: drop V1-only flat `enabled`/`timeout`; `disabled`,
    // `environment`, and any nested timeout object are preserved via the spread.
    delete merged.enabled;
    if (typeof merged.timeout !== 'object' || merged.timeout === null || Array.isArray(merged.timeout)) {
      delete merged.timeout;
    }
  } else {
    if (merged.timeout === undefined && defaultTimeout) merged.timeout = defaultTimeout;
    if (merged.enabled === undefined) merged.enabled = true;
  }
  return { entry: merged, changed: !sameJson(merged, existing) };
}

// Classify an existing OpenCode config by which MCP form the DevKit entry uses:
// `mcp.servers.*` (native V2) vs a flat `mcp.<name>` (legacy V1). Returns 'unknown'
// when the config has no MCP section or no recognizable server entry.
export function detectOpenCodeEra(config) {
  if (!isPlainObject(config) || !isPlainObject(config.mcp)) return 'unknown';
  if (isPlainObject(config.mcp.servers)) return 'v2';
  if (Object.keys(config.mcp).some((key) => key !== 'servers' && isPlainObject(config.mcp[key]))) return 'v1';
  return 'unknown';
}

// Place (or merge) the DevKit entry into an OpenCode config at the correct level
// for the target era. Returns the new config plus whether an entry pre-existed and
// whether anything changed, so callers can skip writes and restore backup deltas.
export function mergeOpenCodeEntry(config, { mcpPath, era = 'v1' } = {}) {
  const base = isPlainObject(config) ? config : {};
  const key = 'huaweicloud-devkit';
  const next = { ...base, mcp: { ...(isPlainObject(base.mcp) ? base.mcp : {}) } };

  if (era === 'v2') {
    const servers = isPlainObject(next.mcp.servers) ? { ...next.mcp.servers } : {};
    // An entry may live in the native `servers` map or the legacy flat map; merge
    // from whichever is present so user fields survive an era switch.
    const existing = servers[key] ?? next.mcp[key];
    const { entry } = mergeCommandStyle(existing, { mcpPath, era: 'v2' });
    servers[key] = entry;
    if (isPlainObject(next.mcp[key])) delete next.mcp[key];
    next.mcp.servers = servers;
    return { config: next, entry, changed: !existing || !sameJson(entry, existing), existing: Boolean(existing) };
  }

  const existing = next.mcp[key];
  const { entry, changed } = mergeCommandStyle(existing, { mcpPath, era: 'v1' });
  next.mcp[key] = entry;
  return { config: next, entry, changed: !existing || changed, existing: Boolean(existing) };
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
  const env = isPlainObject(entry.env) ? entry.env : isPlainObject(entry.environment) ? entry.environment : null;
  if (env) {
    const userEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !REQUIRED_ENV_KEYS.has(key)));
    if (Object.keys(userEnv).length > 0) delta.env = userEnv;
  }
  if (entry.timeout !== undefined && entry.timeout !== 300000) delta.timeout = entry.timeout;
  // Canonical "disabled" marker: V1 uses `enabled:false`, V2 uses `disabled:true`.
  if (entry.enabled === false || entry.disabled === true) delta.enabled = false;
  return Object.keys(delta).length > 0 ? delta : null;
}

// Apply a previously saved delta onto a freshly written default entry.
export function applyUserDelta(entry, delta, style, era = 'v1') {
  if (!isPlainObject(entry) || !isPlainObject(delta)) return entry;
  const merged = { ...entry };
  if (style === 'command' && Array.isArray(delta.commandExtra)) {
    merged.command = [...entry.command, ...delta.commandExtra];
  } else if (style === 'args' && Array.isArray(delta.argsExtra)) {
    merged.args = [...entry.args, ...delta.argsExtra];
  }
  if (isPlainObject(delta.env)) {
    // V2 native entries use `environment`; V1 (and args-style agents) use `env`.
    if (style === 'command' && era === 'v2') {
      merged.environment = { ...(isPlainObject(merged.environment) ? merged.environment : {}), ...delta.env };
      delete merged.env;
    } else {
      merged.env = { ...(isPlainObject(merged.env) ? merged.env : {}), ...delta.env };
    }
  }
  if (delta.timeout !== undefined) merged.timeout = delta.timeout;
  if (delta.enabled === false) {
    // Canonical disabled marker → era-appropriate field.
    if (style === 'command' && era === 'v2') {
      merged.disabled = true;
      delete merged.enabled;
    } else {
      merged.enabled = false;
    }
  }
  return merged;
}

// Collect user-owned environment variables from peer DevKit server entries in the
// same MCP map (e.g. market-preset keys like `huaweicloud-devkit_1` that carry the
// user's temporary STS credentials HW_ACCESS_KEY / HW_SECRET_KEY / HW_SECURITY_TOKEN).
// When the installer writes a NEW `huaweicloud-devkit` entry these must be inherited
// so the freshly installed key also has the user's credentials (the CodeArts Work
// UI never surfaces them; they live only in mcp_settings.json).
export function inheritPeerUserEnv(mcpMap) {
  if (!isPlainObject(mcpMap)) return null;
  const collected = {};
  for (const [key, entry] of Object.entries(mcpMap)) {
    if (key === 'huaweicloud-devkit') continue;
    if (!/^huaweicloud-devkit(?:_|$)/i.test(key) && key !== 'HuaweiCloud DevKit') continue;
    const env = isPlainObject(entry?.environment) ? entry.environment : isPlainObject(entry?.env) ? entry.env : null;
    if (!env) continue;
    for (const [k, v] of Object.entries(env)) {
      if (REQUIRED_ENV_KEYS.has(k)) continue;
      if (typeof v !== 'string' || v === '') continue;
      if (!(k in collected)) collected[k] = v;
    }
  }
  return Object.keys(collected).length > 0 ? collected : null;
}
