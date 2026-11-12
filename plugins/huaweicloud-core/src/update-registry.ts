// dist-tags registry IO for the update machinery: `npm view` (sync and async
// spawn) and the undici fetch path honoring HUAWEICLOUD_NPM_REGISTRY. Part of
// the src/update-* family behind the src/update-check.ts re-export face.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { fetchWithProxy } from './proxy/proxy-agent.ts';
import { asText } from './lib/as-text.ts';
import type { DistTags } from './update-semver.ts';

const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// One-property read with validation, for the JS boundary of thrown values:
// only a non-empty `message` string is surfaced. Exported for the upgrade act
// in update-upgrade.ts.
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message) return record.message;
  }
  return undefined;
}

function toDistTags(value: unknown): DistTags | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    latest: typeof record.latest === 'string' ? record.latest : null,
    next: typeof record.next === 'string' ? record.next : null,
  };
}

export function parseDistTagsOutput(stdout: unknown): DistTags | null {
  try {
    const text = asText(stdout || '').trim();
    if (!text) return null; // 空输出视为 npm view 失败
    return toDistTags(JSON.parse(text));
  } catch {
    return null;
  }
}

function debugLog(message: string): void {
  if (process.env.HUAWEICLOUD_DEVKIT_DEBUG === '1' || process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true') {
    console.error(`[debug] ${message}`);
  }
}

// One spelling rule serves every env channel for the pre-flight and the child:
// trimmed non-empty exact-case first, else the first trimmed non-empty
// case/padding variant; whitespace counts as unset.
export function resolveEnvSpelling(env: NodeJS.ProcessEnv, canonical: string): string | undefined {
  const spellings = Object.entries(env)
    .filter(([key, value]) => key.trim().toUpperCase() === canonical && Boolean(value?.trim()))
    .map(([key, value]) => [key, value!.trim()] as const);
  const exact = spellings.find(([key]) => key === canonical);
  return (exact ?? spellings[0])?.[1];
}

export function resolveRegistryOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveEnvSpelling(env, 'HUAWEICLOUD_NPM_REGISTRY');
}

// The npm auth channels resolve through the same exact-case-first collapse as
// the child env, so duplicate/variant spellings cannot split the halves.
function resolveNpmAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveEnvSpelling(env, 'NPM_TOKEN') ?? resolveEnvSpelling(env, 'NODE_AUTH_TOKEN');
}

// npm reads the userconfig by a case-insensitive `npm_config_userconfig` key,
// trims the value, and skips an empty value (falling back to ~/.npmrc). A
// whitespace-only value trims to an empty path, which is not the fallback.
function resolveUserconfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entry = Object.entries(env)
    .filter(([key]) => key.toUpperCase() === 'NPM_CONFIG_USERCONFIG')
    .at(-1);
  const raw = entry?.[1];
  if (raw === undefined || raw === '') return undefined;
  return expandTilde(raw.trim());
}

function expandTilde(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function localPrefix(start: string = process.cwd()): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function globalconfigPath(env: NodeJS.ProcessEnv): string {
  if (env.npm_config_globalconfig) return expandTilde(env.npm_config_globalconfig);
  const prefix = env.npm_config_prefix || env.PREFIX || dirname(dirname(process.execPath));
  return join(prefix, 'etc', 'npmrc');
}

function stripIniQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

// npm's env-replace: `\${...}` stays literal, `${VAR}` interpolates the exact
// env name (unset keeps the literal), and `${VAR?}` resolves empty when unset.
function envReplace(value: string, env: NodeJS.ProcessEnv): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '\\' && value[index + 1] === '$') {
      out += '$';
      index += 1;
      continue;
    }
    if (char === '$' && value[index + 1] === '{') {
      const end = value.indexOf('}', index + 2);
      if (end < 0) {
        out += char;
        continue;
      }
      let name = value.slice(index + 2, end);
      const optional = name.endsWith('?');
      if (optional) name = name.slice(0, -1);
      const resolved = env[name];
      out += resolved !== undefined ? resolved : optional ? '' : value.slice(index, end + 1);
      index = end;
      continue;
    }
    out += char;
  }
  return out;
}

function parseNpmrc(text: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const match = /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const value = stripIniQuotes(match[2]!.replace(/\s;.*$/, ''));
    entries.set(match[1]!.trim(), envReplace(value, env));
  }
  return entries;
}

// npm's auth cascade: env-spread nerf keys, the project/workspace root
// (nearest package.json), the userconfig, then the global config. Unreadable
// files contribute nothing.
function configLayers(env: NodeJS.ProcessEnv): Array<Map<string, string>> {
  const layers: Array<Map<string, string>> = [];
  const spread = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    const body = /^npm_config_(.*)$/i.exec(key)?.[1];
    if (body?.startsWith('//') && value !== undefined) spread.set(body, envReplace(value, env));
  }
  if (spread.size) layers.push(spread);
  const userconfig = resolveUserconfig(env);
  const files = [join(localPrefix(), '.npmrc'), userconfig ?? join(homedir(), '.npmrc'), globalconfigPath(env)];
  for (const file of files) {
    try {
      layers.push(parseNpmrc(readFileSync(file, 'utf8'), env));
    } catch {
      // an unreadable config layer contributes no keys
    }
  }
  return layers;
}

function basicHeader(username: string | undefined, password: string | undefined): string | undefined {
  if (!username || password === undefined) return undefined;
  const decoded = (() => {
    try {
      return Buffer.from(password, 'base64').toString('utf8');
    } catch {
      return password;
    }
  })();
  return `Basic ${Buffer.from(`${username}:${decoded}`).toString('base64')}`;
}

// The pre-flight auth header for a registry, resolved the way npm resolves it:
// walk the nerf-dart path levels (never past the host root when a path exists),
// and take the first token/basic entry found across the config cascade.
function npmrcAuthHeader(registry: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    return undefined;
  }
  const host = `//${url.host}`;
  const path = url.pathname.replace(/\/+$/, '');
  const levels: string[] = [];
  if (path) {
    let current = path;
    while (current) {
      levels.push(current);
      const next = current.replace(/\/[^/]*$/, '');
      if (next === current) break;
      current = next;
    }
  } else {
    levels.push('');
  }
  const layers = configLayers(env);
  const lookup = (key: string): string | undefined => {
    for (const layer of layers) {
      const value = layer.get(key);
      if (value) return value;
    }
    return undefined;
  };
  for (const level of levels) {
    const prefix = `${host}${level}`;
    const token = lookup(`${prefix}/:_authToken`);
    if (token) return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const auth = lookup(`${prefix}/:_auth`);
    if (auth) return `Basic ${auth}`;
    const basic = basicHeader(lookup(`${prefix}/:username`), lookup(`${prefix}/:_password`));
    if (basic) return basic;
  }
  return undefined;
}

// The pre-flight follows redirects the way npm re-authenticates them: the same
// Authorization header travels to the redirect target (the configured mirror's
// gateway is the realistic shape). This deliberately re-sends the bearer
// cross-origin, matching npm's registry client.
async function fetchFollowingAuth(url: string, init: RequestInit) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchWithProxy(current, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : undefined;
    if (!location) return response;
    try {
      current = new URL(location, current).toString();
    } catch {
      return response;
    }
  }
  return null;
}

export async function queryDistTagsFetch({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<DistTags | null> {
  // One normalization with upgradeEnv: a padded or case-variant spelling is
  // usable and a whitespace-only value is unset, so the pre-flight and the
  // child pin cannot disagree.
  const configured = resolveRegistryOverride();
  let registry = 'https://registry.npmjs.org';
  if (configured) {
    registry = configured.replace(/\/+$/, '');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The pre-flight query needs the same mirror auth the child npm gets: a
  // token-guarded private mirror 401s the packument without it, aborting the
  // act before the spawn. The token is read for this request only; the env
  // shaping of the child is a separate concern.
  // npm's own order: the userconfig's named channel first (an .npmrc value may
  // interpolate NODE_AUTH_TOKEN even when a stale NPM_TOKEN is exported), then
  // the env tokens, then no auth.
  const token = resolveNpmAuthToken();
  const authorization = npmrcAuthHeader(registry) ?? (token ? `Bearer ${token}` : undefined);
  const init: RequestInit = {
    signal: controller.signal,
    ...(authorization ? { headers: { authorization } } : {}),
  };
  try {
    const resp = await fetchFollowingAuth(`${registry}/-/package/huaweicloud-devkit/dist-tags`, init);
    clearTimeout(timer);
    if (!resp || !resp.ok) return null;
    return toDistTags(await resp.json().catch(() => null));
  } catch (error) {
    clearTimeout(timer);
    debugLog(`queryDistTagsFetch: ${errorMessage(error) || String(error)}`);
    return null;
  }
}

export function queryDistTagsSync({
  timeoutMs = 15000,
  cwd,
}: { timeoutMs?: number; cwd?: string } = {}): DistTags | null {
  try {
    // String command, never an args array: args + shell:true is DEP0190 on
    // Node 24, and the words are static so the shell concatenation is
    // injection-safe. shell:true stays load-bearing: it routes npm.cmd on
    // Windows (the #643 EINVAL doctrine below).
    const result = spawnSync(`${NPM_BIN} view huaweicloud-devkit dist-tags --json`, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
      // Windows + Node 22: spawning `npm.cmd` directly throws EINVAL (CVE-2024-27980
      // mitigation); shell:true routes the .cmd through cmd.exe like other spawns (#643).
      shell: true,
    });
    if (result.status !== 0) {
      debugLog(`queryDistTagsSync: npm view exited with status ${result.status}`);
      return null;
    }
    return parseDistTagsOutput(result.stdout);
  } catch (error) {
    debugLog(`queryDistTagsSync: ${errorMessage(error) || String(error)}`);
    return null;
  }
}

export function queryDistTags({
  timeoutMs = 15000,
  cwd,
}: { timeoutMs?: number; cwd?: string } = {}): Promise<DistTags | null> {
  // Registry seam: the CLI face already honors HUAWEICLOUD_NPM_REGISTRY
  // (setup-cli's update command); the tool face silently ignored it — this
  // delegation closes that inconsistency, so every default consumer
  // (getCachedUpdateInfo, upgradePackage) honors the operator/E2E override
  // without spawning npm.
  if (resolveRegistryOverride()) {
    return queryDistTagsFetch({ timeoutMs });
  }
  return new Promise<DistTags | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      // Same string-command doctrine as queryDistTagsSync: no args array
      // under shell (DEP0190 on Node 24), static words only.
      child = spawn(`${NPM_BIN} view huaweicloud-devkit dist-tags --json`, {
        windowsHide: true,
        cwd,
        shell: true,
      });
    } catch (error) {
      debugLog(`queryDistTags: ${errorMessage(error) || String(error)}`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // the child may have already exited; the timeout path resolves null regardless
      }
      debugLog(`queryDistTags: timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      debugLog(`queryDistTags: ${errorMessage(error) || String(error)}`);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(parseDistTagsOutput(stdout));
      } else {
        debugLog(`queryDistTags: npm view exited with code ${code}`);
        resolve(null);
      }
    });
  });
}
