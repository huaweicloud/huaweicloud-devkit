import { runOneShot } from './devbridge-exec.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { DEVBRIDGE_TUNNEL_ID_PATTERN } from './devbridge-validation.ts';
import {
  buildKeepaliveTunnelsReadScript,
  installKeepaliveWatchdog,
  parseKeepaliveTunnelsOutput,
  type KeepaliveTunnel,
} from './devbridge-keepalive.ts';

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

const DEVBRIDGE_PATH_EXPORT = 'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"';
const DEVBRIDGE_LOCK_PATH = '/tmp/devbridge-cleanup.lock';
// Worst-case hold: state 60x2 + apply 60x2 + sync ~150 + release 60 ≈ 450s.
const DEVBRIDGE_LOCK_STALE_MINUTES = 10;
const DEVBRIDGE_CLEANUP_TIMEOUT_MS = 60000;

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

// Tunnel IDs share validateTunnelId's charset — real IDs may contain 0/1/8/9,
// so parsing must not assume the base32 subset.
export function normalizeCleanupMode(raw: unknown): 'stale' | 'all' | 'none' {
  return raw === 'stale' || raw === 'all' || raw === 'none' ? raw : 'stale';
}

// Parse `devbridge list` (0.2.x plain table) behind OSC/CRLF noise. The header
// row is skipped explicitly; data rows start with the tunnel ID. A non-string
// input reads as empty (the stripTerminalEscapes seam's contract).
export function parseDevbridgeTunnelList(stdout: unknown): DevbridgeTunnelRecord[] {
  const text = stripTerminalEscapes(stdout);
  const tunnels: DevbridgeTunnelRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Tunnel\s+ID\b/i.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_-]{4,32})\s+(.+)$/);
    if (!m || !DEVBRIDGE_TUNNEL_ID_PATTERN.test(m[1]!)) continue;
    const id = m[1]!;
    const rest = m[2]!;
    const name = rest.trim().split(/\s{2,}|\t+/)[0] || '';
    const portMatch = rest.match(/tunnel-(\d+)-/);
    const expMatch = rest.match(/(\d+)\s*(day|days|hour|hours|minute|minutes)/i);
    const unit = expMatch ? expMatch[2]!.toLowerCase() : '';
    const multiplier = { day: 86400, days: 86400, hour: 3600, hours: 3600, minute: 60, minutes: 60 }[unit];
    tunnels.push({
      id,
      name,
      port: portMatch ? Number(portMatch[1]) : null,
      expiryText: expMatch ? expMatch[0] : '',
      expirySeconds: expMatch && multiplier ? Number(expMatch[1]) * multiplier : null,
    });
  }
  return tunnels;
}

// Parse `pgrep -af "devbridge host"` output. The executable is anchored so a
// shell wrapper (`bash -c "...devbridge host..."`) is never mistaken for a
// real host process; the args are tokenized flag-by-flag so an ID can sit in
// any position. An unparseable host (no id, no port) is dropped — never killed
// blindly on a guess.
export function parseDevbridgeHostProcesses(stdout: unknown): DevbridgeHostProcess[] {
  const text = stripTerminalEscapes(stdout);
  const hosts: DevbridgeHostProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const execMatch = m[2]!.match(/^(?:\S*\/)?devbridge\s+host\b(.*)$/);
    if (!execMatch) continue;
    const rest = execMatch[1]!.trim();
    const tokens = rest ? rest.split(/\s+/) : [];
    let id: string | null = null;
    let port: number | null = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === '-p' && /^\d+$/.test(tokens[i + 1] || '')) {
        port = Number(tokens[i + 1]);
        i += 1;
      } else if (token === '-e') {
        i += 1;
      } else if (token.startsWith('-')) {
        // unknown flag: skip it
      } else if (!id && DEVBRIDGE_TUNNEL_ID_PATTERN.test(token) && !/^\d+$/.test(token)) {
        id = token;
      }
    }
    if (!id && port == null) continue;
    hosts.push({ pid: Number(m[1]), id, port });
  }
  return hosts;
}

// Decide which tunnels/hosts to remove.
// - protected: keepalive TUNNELS entries (never removed unless mode=all or
//   samePort — the one documented exception)
// - orphan: tunnel record with no live host — removed in stale/quota
// - orphan host: host process with no matching tunnel record — killed
// - quota: also removes the oldest non-protected live tunnels (maxExtra per
//   call) until the new tunnel fits
export function planDevbridgeCleanup({
  tunnels = [],
  hosts = [],
  keepalive = [],
  mode = 'stale',
  samePort = null,
  maxExtra = 1,
}: DevbridgeCleanupOptions & {
  tunnels?: DevbridgeTunnelRecord[];
  hosts?: DevbridgeHostProcess[];
  keepalive?: KeepaliveTunnel[];
} = {}): DevbridgeCleanupPlan {
  if (mode === 'none') return { deleteIds: [], killPids: [] };

  const tunnelIds = new Set(tunnels.map((t) => t.id));
  const protectedIds = new Set(keepalive.map((k) => k.tunnelId).filter(Boolean));
  const portById = new Map<string, number>();
  for (const t of tunnels) if (t.port != null) portById.set(t.id, t.port);
  for (const k of keepalive) {
    const m = String(k.url || '').match(/-(\d+)\.devbridge-s2\./);
    if (m && tunnelIds.has(k.tunnelId)) portById.set(k.tunnelId, Number(m[1]));
  }

  if (mode === 'all') {
    return { deleteIds: [...tunnelIds], killPids: hosts.map((h) => h.pid) };
  }

  const liveIds = new Set<string>();
  const mappedPids = new Set<number>();
  for (const h of hosts) {
    if (!h.id && h.port == null) continue; // unattributable host: never kill blindly
    if (h.id && tunnelIds.has(h.id)) {
      liveIds.add(h.id);
      mappedPids.add(h.pid);
    } else if (h.port != null) {
      for (const [id, port] of portById) {
        if (port === h.port) {
          liveIds.add(id);
          mappedPids.add(h.pid);
        }
      }
    }
  }

  const killPids = new Set(
    hosts.filter((h) => (h.id || h.port != null) && !mappedPids.has(h.pid)).map((h) => h.pid),
  );
  const samePortIds = samePort == null ? [] : tunnels.filter((t) => portById.get(t.id) === samePort).map((t) => t.id);
  const orphanIds = tunnels.filter((t) => !protectedIds.has(t.id) && !liveIds.has(t.id)).map((t) => t.id);
  const deleteSet = new Set([...orphanIds, ...samePortIds]);

  if (mode === 'quota') {
    const candidates = tunnels
      .filter((t) => !protectedIds.has(t.id) && !deleteSet.has(t.id) && liveIds.has(t.id))
      .sort((a, b) => (a.expirySeconds ?? Number.MAX_SAFE_INTEGER) - (b.expirySeconds ?? Number.MAX_SAFE_INTEGER));
    for (let i = 0; i < Math.max(0, maxExtra) && i < candidates.length; i += 1) {
      deleteSet.add(candidates[i]!.id);
    }
  }

  for (const h of hosts) {
    if (h.id && deleteSet.has(h.id)) killPids.add(h.pid);
    else if (h.port != null && [...deleteSet].some((id) => portById.get(id) === h.port)) killPids.add(h.pid);
  }

  return { deleteIds: [...deleteSet], killPids: [...killPids] };
}

export function buildDevbridgeCleanupApplyScript({ deleteIds = [], killPids = [] }: Partial<DevbridgeCleanupPlan> = {}): string {
  for (const id of deleteIds) {
    if (!DEVBRIDGE_TUNNEL_ID_PATTERN.test(String(id))) {
      throw new Error(`devbridge cleanup: invalid tunnel id ${JSON.stringify(id)}`);
    }
  }
  for (const pid of killPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`devbridge cleanup: invalid pid ${JSON.stringify(pid)}`);
    }
  }
  return [
    // #999 anchor doctrine: the export rides the APPLY marker line so the
    // apply exec can never be misrecognized as the auth probe (a standalone
    // export first line is byte-identical to the probe's).
    `${DEVBRIDGE_PATH_EXPORT}; echo "DB_CLEANUP_APPLY"`,
    // Re-check the process identity before killing: state→apply can take
    // minutes, so a recycled PID must not hit an unrelated process.
    ...killPids.map(
      (pid) => `if ps -p ${pid} -o args= 2>/dev/null | grep -q "devbridge host"; then kill ${pid} >/dev/null 2>&1 || true; fi`,
    ),
    `sleep 1`,
    ...deleteIds.map((id) => `devbridge delete ${id} >/dev/null 2>&1 || true`),
    `echo "DB_CLEANUP_DELETED=${deleteIds.join(',')}"`,
    `echo "DB_CLEANUP_KILLED=${killPids.join(',')}"`,
  ].join('\n');
}

export function buildDevbridgeCleanupStateScript(): string {
  return [
    // #999 anchor doctrine: the export rides the token-refresh init — a
    // standalone export first line is byte-identical to the auth probe's
    // opening line, and first-line readers cannot tell them apart.
    `${DEVBRIDGE_PATH_EXPORT}; DB_KEY=""`,
    // 40100 self-heal: a valid API key can coexist with an expired CLI token;
    // without this refresh `devbridge list` returns 40100 and the cleanup
    // silently skips even though the key is usable. Re-login from
    // keyring/file only — never creates a key here.
    `if command -v hwcloud >/dev/null 2>&1; then`,
    `  DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `  case "$DB_KEY" in "devbridge_"*) : ;; *) DB_KEY="";; esac`,
    `fi`,
    `if [ -z "$DB_KEY" ] && [ -s /tmp/hw_api_key ]; then`,
    `  source /tmp/hw_api_key 2>/dev/null || true`,
    `  DB_KEY="\${HW_API_KEY:-}"`,
    `fi`,
    `if [ -n "$DB_KEY" ]; then devbridge auth login --api-key "$DB_KEY" >/dev/null 2>&1 || true; fi`,
    `unset DB_KEY HW_API_KEY 2>/dev/null`,
    `echo "DB_CLEANUP_TUNNELS_BEGIN"`,
    `devbridge list 2>&1 || true`,
    `echo "DB_CLEANUP_TUNNELS_END"`,
    `echo "DB_CLEANUP_HOSTS_BEGIN"`,
    `pgrep -af "devbridge host" 2>&1 || true`,
    `echo "DB_CLEANUP_HOSTS_END"`,
    buildKeepaliveTunnelsReadScript(),
  ].join('\n');
}

export function buildDevbridgeCleanupLockScript(): string {
  return [
    `LOCK=${DEVBRIDGE_LOCK_PATH}`,
    `if mkdir "$LOCK" 2>/dev/null; then echo LOCK_OK; else`,
    `  if find "$LOCK" -maxdepth 0 -mmin +${DEVBRIDGE_LOCK_STALE_MINUTES} 2>/dev/null | grep -q .; then rmdir "$LOCK" 2>/dev/null || true; fi`,
    `  if mkdir "$LOCK" 2>/dev/null; then echo LOCK_OK; else echo LOCK_BUSY; fi`,
    `fi`,
  ].join('\n');
}

function cleanupSection(text: string, name: string): string {
  const m = String(text || '').match(new RegExp(`DB_CLEANUP_${name}_BEGIN\\r?\\n([\\s\\S]*?)DB_CLEANUP_${name}_END`));
  return m ? (m[1] ?? '') : '';
}

// The sandbox terminal occasionally needs >10s to open, so every cleanup exec
// gets a generous budget and one retry on a transient timeout (each op is
// idempotent — a retried lock/apply/release converges to the same state).
async function execCleanupWithRetry(
  workspaceId: string,
  script: string,
  username: string,
  timeoutMs = DEVBRIDGE_CLEANUP_TIMEOUT_MS,
) {
  let lastError: unknown;
  for (let i = 1; i <= 2; i += 1) {
    try {
      return await runOneShot(workspaceId, script, username, timeoutMs);
    } catch (error) {
      lastError = error;
      if (i === 2 || !/timeout|websocket/i.test(String((error as Error)?.message || ''))) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

// Prune the watchdog roster after a cleanup: deleted IDs AND entries that no
// longer exist in the management plane (ghost tunnels from earlier delete-all
// calls would otherwise be re-hosted and renewed forever). "Absent" entries
// are only pruned when at least one live tunnel is confirmed (or an explicit
// all-mode reset) — a transient empty list must not wipe the watchdog and
// silently stop renewals. An empty roster stops the watchdog outright.
async function syncKeepaliveAfterCleanup(
  workspaceId: string,
  {
    deletedIds,
    liveTunnelIds,
    pruneMissing,
    username,
  }: { deletedIds: string[]; liveTunnelIds: Set<string>; pruneMissing: boolean; username: string },
): Promise<void> {
  let current: KeepaliveTunnel[];
  try {
    const read = await execCleanupWithRetry(workspaceId, buildKeepaliveTunnelsReadScript(), username, 30000);
    current = parseKeepaliveTunnelsOutput(read.stdout);
  } catch {
    return;
  }
  if (!current.length) return;
  const deleted = new Set(deletedIds || []);
  const remaining = current.filter((t) => !deleted.has(t.tunnelId) && (!pruneMissing || liveTunnelIds.has(t.tunnelId)));
  if (remaining.length === current.length) return;
  if (remaining.length === 0) {
    try {
      await execCleanupWithRetry(
        workspaceId,
        `pkill -f "tunnel-keepalive.sh" 2>/dev/null || true; rm -f /tmp/tunnel-keepalive.sh`,
        username,
        30000,
      );
    } catch {
      // best-effort: a dead watchdog's leftovers do not need renewal anyway
    }
    return;
  }
  try {
    await installKeepaliveWatchdog(workspaceId, { tunnels: remaining }, username, 30000);
  } catch {
    // best-effort: the pre-existing coverage stands; the deleted tunnels may
    // be re-hosted by the watchdog once more
  }
}

// The cleanup orchestration: lock → refresh token + read state → plan →
// apply → sync the watchdog roster → release. A busy/failed lock or a failed
// list NEVER degrades into deleting anything on a guess.
export async function cleanupDevbridgeTunnels(
  workspaceId: string,
  { mode = 'stale', samePort = null, maxExtra = 1, username = 'root' }: DevbridgeCleanupOptions = {},
): Promise<DevbridgeCleanupResult> {
  if (!workspaceId) throw new Error('devbridge cleanup: workspace_id is required.');
  if (mode === 'none') return { ok: true, skipped: true, deleteIds: [], killPids: [] };

  let lockResult;
  try {
    lockResult = await runOneShot(workspaceId, buildDevbridgeCleanupLockScript(), username, 30000);
  } catch {
    return { ok: false, locked: true, deleteIds: [], killPids: [] };
  }
  if (!stripTerminalEscapes(lockResult.stdout).includes('LOCK_OK')) {
    return { ok: false, locked: true, deleteIds: [], killPids: [] };
  }

  try {
    const stateResult = await execCleanupWithRetry(workspaceId, buildDevbridgeCleanupStateScript(), username, 60000);
    const text = stripTerminalEscapes(stateResult.stdout);
    const tunnelSection = cleanupSection(text, 'TUNNELS');
    const listOk = /Tunnel ID|No tunnels found/i.test(tunnelSection);
    if (!listOk) {
      // list/auth/network failed — do not delete or kill anything on a guess.
      return { ok: false, listFailed: true, deleteIds: [], killPids: [] };
    }
    const tunnels = parseDevbridgeTunnelList(tunnelSection);
    const hosts = parseDevbridgeHostProcesses(cleanupSection(text, 'HOSTS'));
    // Output-format drift guard: header matched but rows didn't parse, while
    // host processes exist. Never mass-kill hosts on a parse we don't trust.
    if (tunnels.length === 0 && hosts.length > 0 && !/No tunnels found/i.test(tunnelSection)) {
      return { ok: false, listFailed: true, deleteIds: [], killPids: [] };
    }
    const keepalive = parseKeepaliveTunnelsOutput(text);
    const liveTunnelIds = new Set(tunnels.map((t) => t.id));
    const pruneMissing = mode === 'all' || liveTunnelIds.size > 0;
    const plan = planDevbridgeCleanup({ tunnels, hosts, keepalive, mode, samePort, maxExtra });
    if (plan.deleteIds.length === 0 && plan.killPids.length === 0) {
      await syncKeepaliveAfterCleanup(workspaceId, { deletedIds: [], liveTunnelIds, pruneMissing, username });
      return { ok: true, deleteIds: [], killPids: [], tunnelCount: tunnels.length };
    }
    await execCleanupWithRetry(
      workspaceId,
      buildDevbridgeCleanupApplyScript(plan),
      username,
      DEVBRIDGE_CLEANUP_TIMEOUT_MS,
    );
    await syncKeepaliveAfterCleanup(workspaceId, { deletedIds: plan.deleteIds, liveTunnelIds, pruneMissing, username });
    return { ok: true, ...plan, tunnelCount: tunnels.length };
  } finally {
    try {
      await execCleanupWithRetry(workspaceId, `rmdir ${DEVBRIDGE_LOCK_PATH} 2>/dev/null || true`, username, 30000);
    } catch {
      // best-effort: the 10-minute stale threshold reclaims an abandoned lock
    }
  }
}
