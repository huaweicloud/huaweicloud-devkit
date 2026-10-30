// Telemetry for huaweicloud-devkit: the session event queue, identity
// stamps, and the daily install/DAU/first-use pings.
//
// Stable public face of the telemetry family (the safety-policy.ts
// re-export precedent): same exported names, same import path, same
// behavior. The internals live in stateless siblings — telemetry-types.ts
// (the shared state/paths/context vocabulary), telemetry-fs.ts (stamp-file
// IO), telemetry-values.ts (event shaping + the os snapshot),
// identity-stamps.ts (machine finger, installation id, user hash, install
// counter, DAU/first-use stamps), hook-ingest.ts (the spool-file ingest
// seams: the hook spool AND the exit spool), event-pipeline.ts (queue,
// awaitable flush, retry, the opt-out gate, the exit-time disk spool) —
// plus the pre-existing agent-detect.ts / invoke-value.ts and the
// detection data face agent-registry.ts (AGENTS + matcher; the version
// detectors live in agent-versions.ts / agent-versions-desktop.ts).
//
// This module deliberately KEEPS the family's load-bearing module-scope
// state: resolvePluginDir and every derived path constant, the
// HUAWEICLOUD_DEVKIT_HOME-derived global telemetry dir, the plugin version,
// the mutable session state record, and the debug logger.
// test/telemetry.test.ts (withIsolatedTelemetry) re-imports THIS module
// with a query string under a fresh HUAWEICLOUD_DEVKIT_HOME — only the
// face re-evaluates, so state or env-derived constants living in a sibling
// would silently survive the isolation. Siblings receive everything via
// the context; they never derive paths or keep module state.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { asText } from '../lib/as-text.ts';
import { installSegment } from './agent-registry.ts';
import { enqueueTrackedEvent, flushEvents, isTelemetryEnabled, spoolEventsForExit } from './event-pipeline.ts';
import {
  checkDauPing,
  clearUserHashFile,
  consumeInstallCounter,
  loadCachedUserHash,
  persistUserHash,
  recordInstall,
  recoverInstallId,
  shouldSendFirstUsePing,
} from './identity-stamps.ts';
import { ingestSpools } from './hook-ingest.ts';
import { ensureDir, stampExists } from './telemetry-fs.ts';
import type { TelemetryContext, TelemetryEventInput, TelemetryPaths, TelemetryState } from './telemetry-types.ts';

// The event pipeline family (queue caps, flush, retry, the opt-out gate).
export { isTelemetryEnabled } from './event-pipeline.ts';
// The value-shaping family (the public sanitizer).
export { sanitizeValue } from './telemetry-values.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The plugin dir must be resolved by marker, never by depth. This module runs
// in three shapes whose __dirname sits at different depths under the plugin
// dir: the tsc tree (<plugin>/dist/telemetry/), the TypeScript source
// (<plugin>/src/telemetry/), and — the shape that broke — the esbuild bundle,
// where every inlined module's import.meta.url collapses to the bundle file
// itself (<plugin>/dist/mcp-server.js). A depth-based two-level parent join
// from __dirname is correct for the first two and one level too high for the
// bundle: it dropped the telemetry dir into the codex plugin cache's version
// PARENT, codex 0.162.1 scanned that directory for version dirs, resolved the
// stray 'telemetry' sibling as the version, and stopped loading the plugin's
// manifest and .mcp.json — "installed and enabled" in `codex plugin list`
// with no MCP server in any session afterwards. Markers: every runtime
// layout keeps dist/ and/or safety/ directly under the plugin dir (dist in
// built layouts, safety in a raw source checkout).
export function resolvePluginDir(startDir: string): string {
  // The raw-checkout marker is safety/ PLUS package.json: the safety family
  // split put a safety/ directory inside src/ too, and a bare safety/ probe
  // made src/ win the first climb from src/telemetry — the identity stamps
  // (install-stamp, dau-stamp, ...) then wrote into the committed source
  // tree on every source-tree test run (measured 2026-10-27: four stray
  // zero-byte stamp files in src/telemetry). src/ never carries the
  // plugin's package.json; every true plugin root (checkout, tsc tree,
  // bundle, npm/codex cache) does.
  for (const candidate of [join(startDir, '..'), join(startDir, '..', '..')]) {
    if (existsSync(join(candidate, 'dist'))) return candidate;
    if (existsSync(join(candidate, 'safety')) && existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return join(startDir, '..', '..');
}
const PLUGIN_DIR = resolvePluginDir(__dirname);
const AGENT_TELEMETRY_DIR = join(PLUGIN_DIR, 'telemetry');
const GLOBAL_TELEMETRY_DIR = join(
  (process.env.HUAWEICLOUD_DEVKIT_HOME || '').trim() || homedir(),
  '.huaweicloud-devkit',
  'telemetry',
);

// The face-owned global-dir derivation, surfaced for INSTALL/UNINSTALL
// consumers outside the family (the workbuddy agent module's directory
// bookkeeping): the server's global telemetry state (exit spool,
// machine-finger, installation-id, user-hash) lives under
// HUAWEICLOUD_DEVKIT_HOME when set, so the installer must create — and the
// uninstaller remove — the SAME directory the server writes. A consumer
// re-rolling a bare-homedir() join ignores the override (the
// port-v2defects residue: install created an orphan dir under the real
// home while the server wrote under the override; uninstall deleted the
// real home's and left the override's behind). Returns the face's
// import-time derivation — the same value every family consumer uses.
export function globalTelemetryDir(): string {
  return GLOBAL_TELEMETRY_DIR;
}

// The family's paths in one record, derived in this module only. The
// agent-dir paths sit inside the plugin dir (they must resolve to the same
// locations in the source, tsc, and bundle shapes — see resolvePluginDir);
// the global identity paths sit under the home override. The exit spool
// rides the global dir (not the agent dir) on purpose: it must survive
// plugin updates that replace the payload dir, and it must follow
// HUAWEICLOUD_DEVKIT_HOME so the test isolation covers it.
const paths: TelemetryPaths = {
  agentTelemetryDir: AGENT_TELEMETRY_DIR,
  hookEventsPath: join(AGENT_TELEMETRY_DIR, 'hook-events.jsonl'),
  exitEventsPath: join(GLOBAL_TELEMETRY_DIR, 'exit-events.jsonl'),
  installStampPath: join(AGENT_TELEMETRY_DIR, 'install-stamp'),
  installCounterPath: join(AGENT_TELEMETRY_DIR, 'install-counter'),
  dauStampPath: join(AGENT_TELEMETRY_DIR, 'dau-stamp'),
  firstUseStampPath: join(AGENT_TELEMETRY_DIR, 'first-use-stamp'),
  debugLogPath: join(AGENT_TELEMETRY_DIR, 'telemetry-debug.log'),
  globalTelemetryDir: GLOBAL_TELEMETRY_DIR,
  machineFingerPath: join(GLOBAL_TELEMETRY_DIR, 'machine-finger'),
  installationIdPath: join(GLOBAL_TELEMETRY_DIR, 'installation-id'),
  userHashPath: join(GLOBAL_TELEMETRY_DIR, 'user-hash'),
};

let PLUGIN_VERSION = '0.0.0';
try {
  const pkg1 = join(PLUGIN_DIR, 'package.json');
  const pkg2 = join(PLUGIN_DIR, '..', '..', 'package.json');
  for (const p of [pkg1, pkg2]) {
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      const v = parsed !== null && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : undefined;
      if (v) {
        PLUGIN_VERSION = asText(v);
        break;
      }
    }
  }
} catch {
  // missing or corrupt package.json means the 0.0.0 fallback version
}

// The session state — ONE mutable record owned by this module (see the
// header: the query-string isolation contract). Siblings mutate it only
// through the context reference below.
const state: TelemetryState = {
  eventQueue: [],
  isFlushing: false,
  inflightFlush: null,
  flushTimer: null,
  lastCheckedDate: '',
  installId: null,
  userHash: null,
  agentHarness: 'unknown',
  agentVersion: '0.0.0',
  // #1040: layout-derived once (never mutated) — the install-position
  // attribution every event carries as its own field.
  installSegment: installSegment(),
};

const FLUSH_INTERVAL_MS = 60_000;

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';
function debugLog(msg: string): void {
  if (!DEBUG) return;
  try {
    ensureDir(dirname(paths.debugLogPath));
    appendFileSync(paths.debugLogPath, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    // best-effort: debug logging must never fail telemetry
  }
}

const ctx: TelemetryContext = { paths, state, pluginVersion: PLUGIN_VERSION, debugLog };

export function generateOrRecoverInstallId(): string {
  return recoverInstallId(ctx);
}

export function enqueueEvent(raw: TelemetryEventInput): void {
  enqueueTrackedEvent(ctx, raw);
}

// The awaitable flush (E4a): resolves when the caller's flush round has
// settled — sent, client-error dropped, or requeued for the next trigger.
// Arriving mid-round chains onto the in-flight round plus one follow-up
// round (the full contract lives on flushEvents in event-pipeline.ts).
// Consumers that must not lose their own event to a session end (the
// voucher P0 flush) await this; the returned promise never rejects.
export function flushTelemetryEvents(): Promise<void> {
  return flushEvents(ctx);
}

// Historical public name (kept for import stability); the seam now covers
// BOTH spool files — the hook spool (input events rebuilt with this
// session's identity) AND the exit spool (full events kept verbatim). See
// ingestSpools in hook-ingest.ts for the shared rename-now/read-next
// pattern and the at-least-once bound.
export function ingestHookEvents(): void {
  ingestSpools(ctx);
}

// The exit-time synchronous spool (E4b): the stdio transport's close paths
// call this immediately before exit. Writes the unflushed queue to the
// exit spool file (full-event JSONL) and clears the queue — the next boot
// ingests it through the same seam as the hook spool. Synchronous by
// necessity (process.exit hosts no async); a no-op when the queue is
// empty, which is also the telemetry-off case (the enqueue gate keeps
// that queue empty). The full residual analysis (in-flight round at exit,
// crash windows, idempotence) lives on spoolEventsForExit.
export function spoolTelemetryEvents(): void {
  spoolEventsForExit(ctx);
}

export function trackInstall(): void {
  if (!isTelemetryEnabled()) return;
  recordInstall(ctx);
}

export function trackToolInvoke(toolName: string, value = '1'): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: `tool:${toolName}`, value });
}

export function trackSkillRetrieve(skillName: string): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'skill:retrieve', value: skillName });
}

export function trackSandboxConnect(): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:connect', value: '1' });
}

export function trackSandboxDisconnect(): void {
  if (!isTelemetryEnabled()) return;
  enqueueEvent({ key: 'sandbox:disconnect', value: '1' });
}

export function cacheUserHash(hash: unknown): void {
  if (typeof hash !== 'string' || !hash) return;
  state.userHash = hash;
  persistUserHash(ctx, hash);
}

export function clearUserHash(): void {
  state.userHash = null;
  clearUserHashFile(ctx);
}

export interface InitTelemetryOptions {
  harness?: string;
  version?: string;
}

export function initTelemetry({ harness, version }: InitTelemetryOptions): void {
  state.installId = recoverInstallId(ctx);
  state.agentHarness = harness || 'unknown';
  state.agentVersion = version || '0.0.0';

  loadCachedUserHash(ctx);

  if (!isTelemetryEnabled()) return;

  if (!stampExists(paths.installStampPath) && !existsSync(paths.installCounterPath)) {
    trackInstall();
  }

  const pendingInstalls = consumeInstallCounter(ctx);
  for (let i = 0; i < pendingInstalls; i++) {
    enqueueEvent({ key: 'plugin:install', value: '1' });
  }

  if (shouldSendFirstUsePing(ctx)) {
    enqueueEvent({ key: 'plugin:first_use', value: '1' });
  }

  if (state.flushTimer) clearInterval(state.flushTimer);
  state.flushTimer = setInterval(() => {
    ingestHookEvents();
    checkDauPing(ctx);
    if (state.eventQueue.length > 0)
      setImmediate(() => {
        void flushEvents(ctx);
      });
  }, FLUSH_INTERVAL_MS);
  state.flushTimer.unref();

  ingestHookEvents();
  if (state.eventQueue.length > 0)
    setImmediate(() => {
      void flushEvents(ctx);
    });
}
