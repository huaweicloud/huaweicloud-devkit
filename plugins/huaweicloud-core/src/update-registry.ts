// dist-tags registry IO for the update machinery: `npm view` (sync and async
// spawn) and the undici fetch path honoring HUAWEICLOUD_NPM_REGISTRY. Part of
// the src/update-* family behind the src/update-check.ts re-export face.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

// The devkit registry override resolves through ONE spelling rule for the
// pre-flight and the child env: trimmed non-empty exact-case first, else the
// first trimmed non-empty case/padding variant; whitespace counts as unset.
export function resolveRegistryOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const spellings = Object.entries(env)
    .filter(([key, value]) => key.trim().toUpperCase() === 'HUAWEICLOUD_NPM_REGISTRY' && Boolean(value?.trim()))
    .map(([key, value]) => [key, value!.trim()] as const);
  const exact = spellings.find(([key]) => key === 'HUAWEICLOUD_NPM_REGISTRY');
  return (exact ?? spellings[0])?.[1];
}

// The npm auth channels resolve through the same padding/case normalization the
// child env applies, so a padded key authenticates both halves.
function resolveNpmAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = Object.entries(env)
    .filter(([key, value]) => {
      const upper = key.trim().toUpperCase();
      return (upper === 'NPM_TOKEN' || upper === 'NODE_AUTH_TOKEN') && Boolean(value?.trim());
    })
    .map(([key, value]) => [key.trim().toUpperCase(), value!.trim()] as const);
  const npmToken = candidates.find(([key]) => key === 'NPM_TOKEN');
  return (npmToken ?? candidates[0])?.[1];
}

// npm's mainstream auth channel is the userconfig `_authToken` for the registry
// host (`npm login` writes it). The pre-flight reads it when the env channels are
// unset, resolving the userconfig the way npm does; with no token anywhere the
// query degrades as before.
function npmrcAuthToken(registry: string): string | undefined {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    return undefined;
  }
  const userconfig = process.env.NPM_CONFIG_USERCONFIG || join(homedir(), '.npmrc');
  let raw: string;
  try {
    raw = readFileSync(userconfig, 'utf8');
  } catch {
    return undefined;
  }
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([^#;\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) entries.set(match[1]!.trim(), match[2]!);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const host = `//${url.host}`;
  const candidates = [`${host}${path}/:_authToken`, `${host}/:_authToken`];
  for (const key of candidates) {
    const value = entries.get(key)?.trim();
    if (value) return value;
  }
  return entries.get('_authToken')?.trim() || undefined;
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
  const token = resolveNpmAuthToken() || npmrcAuthToken(registry);
  const init: RequestInit = token ? { headers: { authorization: `Bearer ${token}` } } : {};
  try {
    const resp = await fetchWithProxy(`${registry}/-/package/huaweicloud-devkit/dist-tags`, init);
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
