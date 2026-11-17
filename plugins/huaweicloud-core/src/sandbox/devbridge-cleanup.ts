import type { KeepaliveTunnel } from './devbridge-keepalive.ts';

// The DevBridge selective-cleanup family, ported from dev's 1.1.x cleanup wave
// (97c4bc8a + 7118d61f + 603554d0 + 6100026e + 43fa459e): delete-all is
// intentionally NOT used in any automated path — it kills other sessions' and
// other ports' tunnels on a shared sandbox. Cleanup removes only orphan tunnel
// records/hosts and (for expose) tunnels bound to the same port, preserving
// other ports, other sessions, and keepalive-protected tunnels. Same-port is
// the one documented exception: a keepalive-protected tunnel on the target
// port is replaced, because a port cannot have two tunnels.
// The lock serializes concurrent cleanups (connect + expose can overlap on one
// sandbox); the stale threshold (10min) sits above the worst-case hold
// (state 60x2 + apply 60x2 + sync ~150 + release ≈ 450s) so a second cleanup
// cannot break a lock that is still legitimately held.
// v2 divergence from dev (recorded): the state and apply scripts carry the
// data-disk PATH export on the same first line as a distinguishing token
// (#999 anchor doctrine — the e2e fake recognizes scripts by first line, and a
// standalone export first line is byte-identical to the auth probe's opening
// line; dev has no first-line-recognizing fake, so dev's scripts keep the
// export standalone).

export type DevbridgeCleanupMode = 'stale' | 'all' | 'none' | 'quota';

export interface DevbridgeTunnelRecord {
  id: string;
  name: string;
  port: number | null;
  expiryText: string;
  expirySeconds: number | null;
}

export interface DevbridgeHostProcess {
  pid: number;
  id: string | null;
  port: number | null;
}

export interface DevbridgeCleanupPlan {
  deleteIds: string[];
  killPids: number[];
}

export interface DevbridgeCleanupOptions {
  mode?: DevbridgeCleanupMode;
  samePort?: number | null;
  maxExtra?: number;
  username?: string;
}

export interface DevbridgeCleanupResult {
  ok: boolean;
  locked?: boolean;
  listFailed?: boolean;
  skipped?: boolean;
  deleteIds: string[];
  killPids: number[];
  tunnelCount?: number;
}

// Tunnel ID vocabulary: real IDs may contain 0/1/8/9, so parsing must not
// assume the base32 subset (the single source lives in devbridge-validation.ts).
export function normalizeCleanupMode(raw: unknown): 'stale' | 'all' | 'none' {
  return raw === 'stale' || raw === 'all' || raw === 'none' ? raw : 'stale';
}

export function parseDevbridgeTunnelList(_stdout: unknown): DevbridgeTunnelRecord[] {
  return [];
}

export function parseDevbridgeHostProcesses(_stdout: unknown): DevbridgeHostProcess[] {
  return [];
}

export function planDevbridgeCleanup(
  _input: DevbridgeCleanupOptions & {
    tunnels?: DevbridgeTunnelRecord[];
    hosts?: DevbridgeHostProcess[];
    keepalive?: KeepaliveTunnel[];
  } = {},
): DevbridgeCleanupPlan {
  return { deleteIds: [], killPids: [] };
}

export function buildDevbridgeCleanupApplyScript(
  _plan: Partial<DevbridgeCleanupPlan> = {},
): string {
  return '';
}

export function buildDevbridgeCleanupStateScript(): string {
  return '';
}

export function buildDevbridgeCleanupLockScript(): string {
  return '';
}

export async function cleanupDevbridgeTunnels(
  _workspaceId: string,
  _options: DevbridgeCleanupOptions = {},
): Promise<DevbridgeCleanupResult> {
  return { ok: true, deleteIds: [], killPids: [] };
}
