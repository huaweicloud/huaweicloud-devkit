// Event shaping for the telemetry family: value sanitization (the public
// sanitizeValue), the key→capability classification, the hook-event JSON
// narrowing, and buildEvent — plus the os snapshot every event carries.
// Stateless beyond the deterministic os snapshot: identity and version
// fields arrive through the context's state and pluginVersion.
import { type as osType, release as osRelease } from 'node:os';

import { asText } from '../lib/as-text.ts';
import type { TelemetryContext, TelemetryEvent, TelemetryEventInput } from './telemetry-types.ts';

const MAX_VALUE_LENGTH = 255;

// The event-queue cap, shared by the two writers that must agree on it:
// the enqueue clamp (event-pipeline.ts) and the ingest clamp
// (hook-ingest.ts). A shared home rather than a mirrored pair — a mirror
// could drift silently, and no behavior test can pin equality without
// enqueueing past the cap. Placed here because both clamp sites already
// value-import this module (event-pipeline's edge into hook-ingest is
// one-way, so hook-ingest could host it too — this home keeps the cap
// beside the other event-shaping constants). Same constant class as
// MAX_VALUE_LENGTH.
export const MAX_EVENT_QUEUE = 500;

const osTypeStr = osType();
const osVersionStr = osRelease();

export function sanitizeValue(value: unknown): string {
  let text = typeof value === 'string' ? value : value == null ? '' : asText(value);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = text.slice(0, MAX_VALUE_LENGTH - 3) + '...';
  }
  return text;
}

function capabilityFromKey(key: string): string | undefined {
  if (key.startsWith('tool:')) return 'mcp';
  if (key.startsWith('cli:')) return 'cli';
  return undefined;
}

export function buildEvent(ctx: TelemetryContext, raw: TelemetryEventInput): TelemetryEvent {
  const event: TelemetryEvent = {
    key: raw.key,
    value: sanitizeValue(raw.value),
    installId: ctx.state.installId,
    userHash: ctx.state.userHash,
    version: ctx.pluginVersion,
    harness: ctx.state.agentHarness,
    agentVersion: ctx.state.agentVersion,
    os: osTypeStr,
    osVersion: osVersionStr,
  };
  // #1040: the install-position attribution as its own sanitized field —
  // set only when the face resolved a segment (a null layout emits none).
  const seg = ctx.state.installSegment;
  if (seg) event.installSegment = sanitizeValue(seg);
  const cap = raw.capability || capabilityFromKey(raw.key);
  if (cap) event.capability = cap;
  return event;
}

// Hook-event JSON arrives as text; only an object carrying a non-empty string
// key is accepted. Malformed lines are dropped rather than queued.
export function toTelemetryEventInput(value: unknown): TelemetryEventInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || record.key === '') return null;
  const input: TelemetryEventInput = { key: record.key, value: record.value };
  if (typeof record.capability === 'string') input.capability = record.capability;
  return input;
}

// Exit-spool lines are FULL built events (spoolEventsForExit serialized the
// queue verbatim): they carry the EXITING session's identity stamps —
// installId, harness, versions, os snapshot — so the ingest narrows
// strictly and enqueues verbatim, never rebuilding (buildEvent would
// re-stamp the event with the NEXT session's identity and falsify the
// data). A line that fails the shape is dropped, same policy as the hook
// spool's malformed lines.
export function toTelemetryEvent(value: unknown): TelemetryEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || record.key === '') return null;
  if (typeof record.value !== 'string') return null;
  if (typeof record.version !== 'string') return null;
  if (typeof record.harness !== 'string') return null;
  if (typeof record.agentVersion !== 'string') return null;
  if (typeof record.os !== 'string') return null;
  if (typeof record.osVersion !== 'string') return null;
  const event: TelemetryEvent = {
    key: record.key,
    value: record.value,
    installId: typeof record.installId === 'string' ? record.installId : null,
    userHash: typeof record.userHash === 'string' ? record.userHash : null,
    version: record.version,
    harness: record.harness,
    agentVersion: record.agentVersion,
    os: record.os,
    osVersion: record.osVersion,
  };
  if (typeof record.capability === 'string') event.capability = record.capability;
  // #1040: the exiting session's install-position field rides verbatim —
  // a non-string drops the field, never the line.
  if (typeof record.installSegment === 'string' && record.installSegment !== '') {
    event.installSegment = record.installSegment;
  }
  if (typeof record._retries === 'number' && Number.isSafeInteger(record._retries) && record._retries >= 0) {
    event._retries = record._retries;
  }
  return event;
}

// Family-internal: the machine finger (identity-stamps.ts) folds the same
// os snapshot into its factor, so the snapshot has exactly one home.
export { osTypeStr };
