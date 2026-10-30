import { asText } from '../lib/as-text.ts';
import { DEVBRIDGE_RENEW_HOURS, validateTunnelId } from './devbridge-validation.ts';
import { runOneShot } from './devbridge-exec.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { readDbField } from './devbridge-expose.ts';

// The keepalive watchdog family, extracted from devbridge-tunnel: the
// three-layer watchdog script (host re-attach + daily renewal + health check),
// the installed-watchdog tunnel read, its parser, the merge, and the install
// flow. Validators and the renewal horizon come from devbridge-validation.ts;
// the DB_* field reader from the expose stdout grammar's canonical home.

export interface KeepaliveTunnel {
  tunnelId: string;
  url: string;
}

// Build the keepalive watchdog script for a set of known tunnels (the
// three-layer pattern proven in the 2026-10 tunnel-persistence test):
//   1. host watchdog — re-attach with `devbridge host <id>` when the host
//      process dies; the URL is bound to the tunnel ID, so it never changes
//   2. daily renewal — `devbridge update <id> -e 720` (29-day failure tolerance)
//   3. health check — curl each URL every 5 minutes, log on non-200/304
// URLs are HARDCODED per tunnel (tunnel IDs never change), NOT derived from
// `devbridge port list` — that table's lines are wrapped in OSC escapes on
// integration-enabled shells, so anchored greps silently fail and the
// constructed health URL 404s (measured 2026-10).
// v2 divergences from main's script (recorded): the PATH export is
// data-disk-first (#999); the health-check curl carries --noproxy '*'
// (#1000 — main's own keepalive missed it; without it the watchdog logs WARN
// 502/404 fakes for healthy tunnels) and drops main's `|| echo "000"` (the
// file's documented sentinel-doubling doctrine — an empty HC still WARNs);
// and the layer-1 probe matches BOTH host launch forms (main's single-form
// pgrep cannot see the -p-form host expose_tunnel itself launched and
// spuriously "restarts" it on the first tick).
export function buildDevbridgeKeepaliveScript(tunnels: unknown): string {
  if (!Array.isArray(tunnels) || tunnels.length === 0) {
    throw new Error('sandbox keepalive: tunnels must be a non-empty array of {tunnelId, url}.');
  }
  const entries = (tunnels as Array<Record<string, unknown>>)
    .map((t) => {
      const id = validateTunnelId(t?.tunnelId);
      const url = asText(t?.url ?? '');
      if (!/^https:\/\/[A-Za-z0-9:._/-]+$/.test(url)) {
        throw new Error(
          `sandbox keepalive: invalid tunnel URL ${JSON.stringify(url.slice(0, 80))} for the keepalive health check. Expected an https:// URL with URL-safe characters (from huaweicloud_sandbox_expose_tunnel's publicUrl).`,
        );
      }
      // The URL embeds the port (https://<id>-<port>.domain) — the layer-1
      // liveness probe needs BOTH host launch forms: expose_tunnel starts
      // `devbridge host -p <port>` (the ID does not exist at launch), the
      // re-attach form is `devbridge host <id>`. A single-form pgrep misses
      // the live -p-form host and spuriously "restarts" it on the first tick
      // (v2 fix — main's watchdog carries the single-form miss).
      const port = url.match(/-(\d+)\.[^.]+\.[^.]+\.[^.]+\/?$/)?.[1] ?? '';
      return port ? `${id}:${url}:${port}` : `${id}:${url}:`;
    })
    .join(' ');
  // Heredoc is single-quoted ('DB_KEEPALIVE_EOF') so the writer shell expands
  // nothing; all ${...} expansion happens inside the watchdog at runtime.
  const body = [
    `#!/bin/bash`,
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `# entries: tunnelId:url (URLs are stable — tunnel IDs never change)`,
    `TUNNELS="${entries}"`,
    `declare -A LAST_RENEW`,
    `while true; do`,
    `  NOW=$(date -u +%s)`,
    `  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    `  for entry in $TUNNELS; do`,
    `    ID="\${entry%%:*}"; REST="\${entry#*:}"; URL="\${REST%:*}"; PORT="\${REST##*:}"`,
    `    if ! pgrep -f "devbridge host $ID" > /dev/null 2>&1 && ! pgrep -f "devbridge host -p $PORT" > /dev/null 2>&1; then`,
    `      if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & else nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & fi`,
    `      echo "$TS host $ID restarted (same tunnel, URL unchanged)" >> /tmp/tunnel-keepalive.log`,
    `      sleep 8`,
    `    fi`,
    `    if [ $((\${LAST_RENEW[$ID]:-0})) -eq 0 ] || [ $((NOW - \${LAST_RENEW[$ID]})) -ge 86400 ]; then`,
    `      if devbridge update "$ID" -e ${DEVBRIDGE_RENEW_HOURS} > /tmp/keepalive-last-update.log 2>&1; then`,
    `        echo "$TS renew $ID ok (${DEVBRIDGE_RENEW_HOURS}h)" >> /tmp/tunnel-keepalive.log`,
    `      else`,
    `        echo "$TS renew $ID FAILED: $(head -1 /tmp/keepalive-last-update.log)" >> /tmp/tunnel-keepalive.log`,
    `      fi`,
    `      LAST_RENEW[$ID]=$NOW`,
    `    fi`,
    `    HC=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" --max-time 10 "$URL/" 2>/dev/null)`,
    `    if [ "$HC" != "200" ] && [ "$HC" != "304" ]; then`,
    `      echo "$TS health $ID WARN http=$HC" >> /tmp/tunnel-keepalive.log`,
    `    fi`,
    `  done`,
    `  sleep 300`,
    `done`,
  ].join('\n');
  return [
    // #999 anchor doctrine: the export rides the same first line as the pkill
    // so first-line readers (the e2e fake, any diagnostics consumer) see one
    // stable anchor — a standalone export first line is byte-identical to the
    // auth probe's opening line and cannot be told apart by first-line
    // recognition (measured on the e2e legs: the install one-shot was
    // misread as an auth probe, its DB_ fields lost, and the resulting
    // enrollment-failure warning taught the model to retry).
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "tunnel-keepalive.sh" 2>/dev/null || true`,
    `sleep 1`,
    `cat > /tmp/tunnel-keepalive.sh << 'DB_KEEPALIVE_EOF'`,
    body,
    `DB_KEEPALIVE_EOF`,
    `chmod +x /tmp/tunnel-keepalive.sh`,
    `bash -n /tmp/tunnel-keepalive.sh > /dev/null 2>&1`,
    `echo "DB_KEEPALIVE_SYNTAX=$?"`,
    `if command -v setsid > /dev/null 2>&1; then setsid nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & else nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    `sleep 3`,
    `echo "DB_KEEPALIVE_PID=$(pgrep -f 'tunnel-keepalive.sh' | head -1)"`,
    `echo "DB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log"`,
  ].join('\n');
}

// Read the tunnel list of the INSTALLED watchdog (if any). The TUNNELS line in
// /tmp/tunnel-keepalive.sh is the single source of truth for what is currently
// protected; expose_tunnel reads it before installing so the new tunnel is
// MERGED into the existing protection instead of replacing it.
export function buildKeepaliveTunnelsReadScript(): string {
  return [
    `LINE=$(grep -m1 '^TUNNELS=' /tmp/tunnel-keepalive.sh 2>/dev/null | sed 's/^TUNNELS=//; s/^"//; s/"$//')`,
    `echo "DB_KEEPALIVE_TUNNELS=$LINE"`,
  ].join('\n');
}

// Parse the raw stdout of buildKeepaliveTunnelsReadScript. Empty output (no
// watchdog installed yet) yields [].
export function parseKeepaliveTunnelsOutput(stdout: unknown): KeepaliveTunnel[] {
  const text = stripTerminalEscapes(stdout);
  const m = text.match(/^DB_KEEPALIVE_TUNNELS=(.*)$/m);
  const line = m ? (m[1] ?? '').trim() : '';
  if (!line) return [];
  return line
    .split(/\s+/)
    .map((entry) => {
      const i = entry.indexOf(':');
      return i > 0 ? { tunnelId: entry.slice(0, i), url: entry.slice(i + 1) } : null;
    })
    .filter((t): t is KeepaliveTunnel => t !== null);
}

// Merge the current watchdog tunnels with the incoming ones: dedupe by
// tunnelId, incoming wins (same tunnel re-exposed refreshes its URL), existing
// order preserved, new tunnels appended. Known limit: the read and the install
// are two execs — two CONCURRENT expose_tunnel calls on the same sandbox can
// interleave them and last-writer-wins drops the other's tunnel (documented;
// single-sandbox concurrency is not a supported posture).
export function mergeKeepaliveTunnels(existing: unknown, incoming: unknown): KeepaliveTunnel[] {
  const byId = new Map<string, KeepaliveTunnel>();
  for (const t of (Array.isArray(existing) ? existing : []) as Array<Record<string, unknown>>) {
    if (t?.tunnelId && t?.url) byId.set(asText(t.tunnelId), { tunnelId: asText(t.tunnelId), url: asText(t.url) });
  }
  for (const t of (Array.isArray(incoming) ? incoming : []) as Array<Record<string, unknown>>) {
    if (t?.tunnelId && t?.url) byId.set(asText(t.tunnelId), { tunnelId: asText(t.tunnelId), url: asText(t.url) });
  }
  return [...byId.values()];
}

export interface KeepaliveWatchdogResult {
  ok: boolean;
  scriptPath?: string;
  logPath?: string;
  watchdogPid?: string;
  tunnels?: KeepaliveTunnel[];
  error?: string;
}

// Install the keepalive watchdog in the sandbox. Validates every tunnel ID and
// URL before splicing, aborts on a bash syntax error (DB_KEEPALIVE_SYNTAX != 0),
// and reports the watchdog PID. Replacing the watchdog (re-running the tool)
// kills the old loop first so two loops never double-renew.
export async function installKeepaliveWatchdog(
  workspaceId: string,
  { tunnels }: { tunnels: unknown },
  username = 'root',
  timeoutMs = 60000,
): Promise<KeepaliveWatchdogResult> {
  if (!workspaceId) {
    throw new Error('sandbox keepalive: workspace_id is required.');
  }
  const script = buildDevbridgeKeepaliveScript(tunnels);
  const result = await runOneShot(workspaceId, script, username, timeoutMs);
  const text = stripTerminalEscapes(result.stdout);
  const syntax = readDbField(text, 'DB_KEEPALIVE_SYNTAX');
  if (syntax !== '0') {
    return {
      ok: false,
      error: `keepalive watchdog script failed the bash -n syntax check (exit ${syntax || 'unknown'}).`,
    };
  }
  // The syntax gate alone is a weak success: the launch is unconditional, so a
  // watchdog that dies inside the 3-second window (noexec /tmp, spawn failure)
  // would report ok with no PID — a silent non-existence for a subsystem whose
  // whole point is unattended liveness. An empty PID is an honest failure.
  const pid = readDbField(text, 'DB_KEEPALIVE_PID');
  if (!pid) {
    return {
      ok: false,
      error:
        'keepalive watchdog passed the syntax check but no running PID was found after launch — the script may have died immediately (noexec /tmp? missing bash?). Inspect /tmp/tunnel-keepalive.log.',
    };
  }
  return {
    ok: true,
    scriptPath: '/tmp/tunnel-keepalive.sh',
    logPath: readDbField(text, 'DB_KEEPALIVE_LOG') || '/tmp/tunnel-keepalive.log',
    watchdogPid: pid,
    tunnels: ((Array.isArray(tunnels) ? tunnels : []) as Array<Record<string, unknown>>).map((t) => ({
      tunnelId: asText(t.tunnelId),
      url: asText(t.url),
    })),
  };
}

// The AUTO-ENROLL phase of exposeTunnel (see the flow's return-shape comment):
// read the installed watchdog's tunnel list and merge the new tunnel into it —
// MERGED, never replacing other tunnels' coverage. keepalive:false opts out.
// Non-fatal: an enrollment failure is surfaced as a warning (appended to the
// caller's array), never as a failed expose — the tunnel itself is working.
// The warning texts are the flow's verbatim lines.
export async function enrollKeepalive(
  workspaceId: string,
  tunnel: { tunnelId: string; url: string },
  keepalive: boolean | undefined,
  warnings: string[],
  username: string,
): Promise<KeepaliveWatchdogResult | undefined> {
  if (keepalive !== false && tunnel.url && !tunnel.tunnelId) {
    warnings.push(
      'Keepalive enrollment skipped: the tunnel ID could not be derived from the exposed URL — the tunnel works but will NOT be auto-renewed.',
    );
  }
  if (keepalive !== false && tunnel.url && tunnel.tunnelId) {
    try {
      const readResult = await runOneShot(workspaceId, buildKeepaliveTunnelsReadScript(), username, 20000);
      const existing = parseKeepaliveTunnelsOutput(readResult.stdout);
      const merged = mergeKeepaliveTunnels(existing, [{ tunnelId: tunnel.tunnelId, url: tunnel.url }]);
      const enrollment = await installKeepaliveWatchdog(workspaceId, { tunnels: merged }, username, 30000);
      if (!enrollment.ok) {
        warnings.push(
          `Keepalive watchdog enrollment failed: ${enrollment.error || 'unknown error'} — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
        );
      }
      return enrollment;
    } catch (error) {
      warnings.push(
        `Keepalive watchdog enrollment failed (${error instanceof Error ? error.message : 'unknown error'}) — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
      );
    }
  }
  return undefined;
}
