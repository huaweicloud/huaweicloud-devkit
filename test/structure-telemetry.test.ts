// Structure guards for the telemetry family split (REPORT-tmtr.md):
// telemetry.ts stays the public face AND the owner of every layout- or
// env-derived module constant plus the mutable session state. The reason
// is the isolation contract in telemetry.test.ts (withIsolatedTelemetry):
// it re-imports the FACE with a query string under a fresh
// HUAWEICLOUD_DEVKIT_HOME, and only the face re-evaluates — siblings
// resolve to their already-cached module instances, so any state or
// env-derived constant hiding in a sibling would silently survive the
// isolation with stale values. These guards pin the ownership so a future
// extraction cannot drift it without rewriting this file.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot, readSource } from './structure-helpers.ts';

const FACE = 'src/telemetry/telemetry.ts';

// The stateless-by-design siblings of the face split, DISCOVERED from the
// directory so a future sibling is held to the same rule automatically.
// The exclusion cluster below is the agent-detection side of the family:
// agent-detect.ts / agent-registry.ts / agent-versions*.ts never depended
// on face-owned state, and agent-registry's selfPath is path-PATTERN
// matching against the module's own URL (not plugin-dir derivation).
// invoke-value.ts is a tools.ts-owned seam with its own stateless shape.
const DETECTION_CLUSTER = new Set([
  'agent-detect.ts',
  'agent-registry.ts',
  'agent-versions.ts',
  'agent-versions-desktop.ts',
  'invoke-value.ts',
  'telemetry.ts',
]);
const STATELESS_SIBLINGS = readdirSync(join(pluginRoot, 'src', 'telemetry'))
  .filter((name) => name.endsWith('.ts') && !DETECTION_CLUSTER.has(name))
  .map((name) => `src/telemetry/${name}`)
  .sort((a, b) => a.localeCompare(b));

test('telemetry face owns the marker resolver, the derived paths, and the session state', () => {
  const face = readSource(FACE);
  // The marker-based plugin-dir resolution (the codex bundle-flattening
  // incident; behavior pinned in telemetry-plugin-dir.test.ts) stays in
  // the face, exported under the same name and feeding the one paths
  // record the whole family receives.
  assert.match(face, /export function resolvePluginDir\(startDir: string\): string \{/);
  assert.match(face, /const PLUGIN_DIR = resolvePluginDir\(__dirname\);/);
  // The env-derived global telemetry dir is derived at FACE module scope:
  // a sibling derivation would survive a fresh HUAWEICLOUD_DEVKIT_HOME
  // with the old value (the query-import isolation re-evaluates only the
  // face).
  assert.match(
    face,
    /const GLOBAL_TELEMETRY_DIR = join\(\s*\(process\.env\.HUAWEICLOUD_DEVKIT_HOME \|\| ''\)\.trim\(\) \|\| homedir\(\),/,
  );
  // The single state record and the context threaded to every sibling.
  assert.match(face, /const state: TelemetryState = \{/);
  assert.match(face, /const ctx: TelemetryContext = \{ paths, state, pluginVersion: PLUGIN_VERSION, debugLog \};/);
});

test('telemetry family siblings stay stateless: no home-env or self-path derivation', () => {
  // The discovered list must hold the six split siblings — a rename that
  // silently empties or shrinks it must fail loudly, not pass vacuously.
  assert.deepEqual(STATELESS_SIBLINGS, [
    'src/telemetry/event-pipeline.ts',
    'src/telemetry/hook-ingest.ts',
    'src/telemetry/identity-stamps.ts',
    'src/telemetry/telemetry-fs.ts',
    'src/telemetry/telemetry-types.ts',
    'src/telemetry/telemetry-values.ts',
  ]);
  for (const name of STATELESS_SIBLINGS) {
    const src = readSource(name);
    // Code-shaped checks (process.env. access): prose mentions of the env
    // var in doctrine comments are fine, code reads are not.
    assert.ok(
      !src.includes('process.env.HUAWEICLOUD_DEVKIT_HOME'),
      `${name} must not read HUAWEICLOUD_DEVKIT_HOME (face-owned)`,
    );
    assert.ok(!src.includes('import.meta.url'), `${name} must not derive paths from import.meta.url (face-owned)`);
    assert.ok(!src.includes('__dirname'), `${name} must not derive paths by __dirname depth (face-owned)`);
    // The workbuddy residue class (bare homedir() path derivation): a
    // sibling joining a home path escapes the query-string isolation the
    // same way an env read would. identity-stamps.ts legitimately folds
    // homedir() into the machine-finger FACTOR (not a path) — the ban is
    // scoped to the join shape.
    assert.ok(
      !src.includes('join(homedir('),
      `${name} must not derive paths from homedir() (face-owned; see the workbuddy.ts residue class)`,
    );
  }
});

test('telemetry face keeps the public surface under the same import path', () => {
  const face = readSource(FACE);
  // The direct importers (src/tools.ts, src/mcp-protocol.ts,
  // src/lib/credentials.ts, src/sandbox/hwlink-connection.ts,
  // src/lib/hdkit/hdkitservice-api.ts) and the test suite import these
  // names from src/telemetry/telemetry.ts — every pre-split export stays
  // a face export.
  for (const name of [
    'resolvePluginDir',
    'globalTelemetryDir',
    'generateOrRecoverInstallId',
    'enqueueEvent',
    'flushTelemetryEvents',
    'ingestHookEvents',
    'spoolTelemetryEvents',
    'trackInstall',
    'trackToolInvoke',
    'trackSkillRetrieve',
    'trackSandboxConnect',
    'trackSandboxDisconnect',
    'cacheUserHash',
    'clearUserHash',
    'initTelemetry',
  ]) {
    assert.match(face, new RegExp(`export function ${name}\\(`), `${name} must stay a face export`);
  }
  // The two pure re-exports and the options interface.
  assert.match(face, /export \{ isTelemetryEnabled \} from '\.\/event-pipeline\.ts';/);
  assert.match(face, /export \{ sanitizeValue \} from '\.\/telemetry-values\.ts';/);
  assert.match(face, /export interface InitTelemetryOptions \{/);
});

test('agent-registry keeps the detection data face; version detectors moved out', () => {
  // agent-detect.ts imports AGENTS, matchAgent, detectVersion, and
  // installSegment from agent-registry.ts — the registry keeps the table
  // and the matcher, and re-exports detectVersion from the detector
  // family so that import path never breaks.
  const registry = readSource('src/telemetry/agent-registry.ts');
  assert.match(registry, /export const AGENTS: AgentDefinition\[\] = \[/);
  assert.match(registry, /export function matchAgent\(/);
  assert.match(registry, /export function installSegment\(/);
  assert.match(registry, /export function findAgentById\(/);
  assert.match(registry, /export \{ detectVersion \} from '\.\/agent-versions\.ts';/);
  // The detectors themselves no longer live in the registry.
  assert.doesNotMatch(registry, /function detectCodeArtsVersion/);
  assert.doesNotMatch(registry, /VERSION_DETECTORS/);
});

// The exit-spool handover must precede BOTH transport exit paths — no
// event-loop turn runs between the spool and the hard exit, and that turn
// is exactly where an async flush would otherwise have had to live. The
// behavior tests (telemetry.test.ts) drive the real paths via the streams
// seam and a patched process.exit; these pins keep the wiring from being
// silently swapped, dropped, or moved during refactors.
test('stdio transport hands the queue to the exit spool before both exit paths', () => {
  const transport = readSource('src/mcp-stdio-transport.ts');
  assert.match(
    transport,
    /spoolTelemetryEvents\(\);\s*\n\s*process\.exit\(0\);/,
    'the stdin-close hard-exit path must spool before process.exit(0)',
  );
  assert.match(
    transport,
    /spoolTelemetryEvents\(\);\s*\n\s*process\.exitCode = 0;/,
    'the stdout-close natural-drain path must spool before the close',
  );
  // The keepalive branch (Hermes on Windows) is EXACTLY the timer arm —
  // no spool, no exit: the session continues (its tail is spooled later
  // by the stdout-close path). The exact-shape pin trips on any statement
  // added to the branch, which is the point.
  assert.match(
    transport,
    /if \(this\.needsKeepalive\) \{\s*this\.keepAlive = setInterval\(\(\) => \{\}, 60000\);\s*\} else \{/,
    'the keepalive branch must stay the bare timer arm (no spool, no exit)',
  );
  // The streams seam's production default is the REAL process streams.
  assert.match(
    transport,
    /options\.streams\?\.stdin \?\? processStdin/,
    'the streams seam must default to the real process stdin',
  );
  assert.match(
    transport,
    /options\.streams\?\.stdout \?\? processStdout/,
    'the streams seam must default to the real process stdout',
  );
  const serverEntry = readSource('src/mcp-server.ts');
  assert.match(
    serverEntry,
    /new DevkitStdioTransport\(\)/,
    'the stdio entry must construct the transport with the default (real) streams',
  );
});

// The ingest seam's call sites: the exit spool rides the SAME seam as the
// hook spool, so the production recovery paths are (1) every enqueue, (2)
// the initTelemetry trailing call, (3) the periodic timer tick. Losing any
// of the three call sites strands spool files (the twin-boot behavior test
// drives the seam directly; these pins keep the production wiring whole).
test('the spool ingest seam fires from every enqueue, the boot tail, and the timer', () => {
  const pipeline = readSource('src/telemetry/event-pipeline.ts');
  assert.match(
    pipeline,
    /if \(!ctx\.state\.installId\) return;\s*\n\s*ingestSpools\(ctx\);/,
    'enqueueTrackedEvent must ingest the spools on every enqueue',
  );
  const face = readSource(FACE);
  assert.match(
    face,
    /state\.flushTimer = setInterval\(\(\) => \{\s*\n\s*ingestHookEvents\(\);/,
    'the periodic timer tick must ingest the spools',
  );
  assert.match(
    face,
    /\n\s*ingestHookEvents\(\);\s*\n\s*if \(state\.eventQueue\.length > 0\)/,
    'initTelemetry must run the trailing ingest before arming the boot flush',
  );
});
