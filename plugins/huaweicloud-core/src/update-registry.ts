// dist-tags registry IO for the update machinery: `npm view` (sync and async
// spawn) and the undici fetch path honoring HUAWEICLOUD_NPM_REGISTRY. Part of
// the src/update-* family behind the src/update-check.ts re-export face.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

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

export async function queryDistTagsFetch({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<DistTags | null> {
  let registry = 'https://registry.npmjs.org';
  if (process.env.HUAWEICLOUD_NPM_REGISTRY) {
    registry = process.env.HUAWEICLOUD_NPM_REGISTRY.replace(/\/+$/, '');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchWithProxy(`${registry}/-/package/huaweicloud-devkit/dist-tags`);
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
  if (process.env.HUAWEICLOUD_NPM_REGISTRY) {
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
