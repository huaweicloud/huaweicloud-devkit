// Shared vocabulary of the telemetry family (the telemetry.ts face split).
// Types only — no runtime code, so siblings import freely without cycles.
//
// The STATE and PATHS records described here are constructed by the face
// (src/telemetry/telemetry.ts) at module scope and threaded through every
// family function as one context. That placement is load-bearing:
// test/telemetry.test.ts isolates module state by re-importing the FACE
// with a query string under a fresh HUAWEICLOUD_DEVKIT_HOME — only the face
// re-evaluates; sibling specifiers resolve to their already-cached module
// instances. Siblings must therefore stay stateless: no module-level
// mutable state and no load-time env/layout-derived constants (per-call
// env reads like the opt-out gate are fine). Everything layout- or
// home-derived lives in the face and rides in on the context.

// `value` stays unknown at the boundary: callers pass strings, but
// hook-event JSON is parsed and validated before it reaches buildEvent.
export interface TelemetryEventInput {
  key: string;
  value?: unknown;
  capability?: string;
}

export interface TelemetryEvent {
  key: string;
  value: string;
  installId: string | null;
  userHash: string | null;
  version: string;
  harness: string;
  agentVersion: string;
  os: string;
  osVersion: string;
  // #1040: the install-position attribution as its own field — never
  // concatenated into harness (the '|' dashboard pollution). Optional
  // because a null segment (unresolvable layout) emits no field.
  installSegment?: string;
  capability?: string;
  _retries?: number;
}

// The mutable session state of the telemetry pipeline, held as ONE record
// (not scattered `let`s) so sibling modules can read and mutate it through
// the shared context reference while the face keeps the only copy — a
// fresh face evaluation means a fresh record.
export interface TelemetryState {
  eventQueue: TelemetryEvent[];
  isFlushing: boolean;
  // The in-flight flush round's promise, set when a round starts and
  // cleared when it settles. Awaitability (flushEvents returns a Promise)
  // needs a rendezvous point: a caller arriving mid-round cannot build a
  // promise from the round it missed, so the round stores itself here and
  // late callers chain onto it (see event-pipeline.ts).
  inflightFlush: Promise<void> | null;
  flushTimer: NodeJS.Timeout | null;
  lastCheckedDate: string;
  installId: string | null;
  userHash: string | null;
  agentHarness: string;
  agentVersion: string;
  // #1040: the install-position segment (agent-registry's installSegment),
  // derived ONCE by the face at module scope — layout-derived like the
  // paths, so it lives here rather than in a sibling, and never mutates
  // after load. buildEvent stamps it onto every event as its own field.
  installSegment: string | null;
}

// Every stamp/spool/log path the family touches, derived once by the face
// from resolvePluginDir + HUAWEICLOUD_DEVKIT_HOME. Paths are never derived
// per-sibling (see the face for the marker-resolution doctrine).
export interface TelemetryPaths {
  agentTelemetryDir: string;
  hookEventsPath: string;
  // The exit spool (full-event JSONL written synchronously at process
  // exit, ingested on the next boot). GLOBAL-dir on purpose, unlike the
  // hook spool: it must survive plugin updates that replace the payload
  // dir, and it must follow HUAWEICLOUD_DEVKIT_HOME so test isolation
  // (the query-string face re-import under a fresh home) covers it.
  exitEventsPath: string;
  installStampPath: string;
  installCounterPath: string;
  dauStampPath: string;
  firstUseStampPath: string;
  debugLogPath: string;
  globalTelemetryDir: string;
  machineFingerPath: string;
  installationIdPath: string;
  userHashPath: string;
}

// What every family function receives: the face-owned paths and state, the
// resolved plugin version, and the face's debug logger.
export interface TelemetryContext {
  paths: TelemetryPaths;
  state: TelemetryState;
  pluginVersion: string;
  debugLog: (msg: string) => void;
}
