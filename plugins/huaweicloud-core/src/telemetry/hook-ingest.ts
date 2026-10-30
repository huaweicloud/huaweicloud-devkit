// The spool-file ingest seams. Two JSONL spools converge here, sharing one
// crash-recovery pattern: the PreToolUse hooks' hook-events.jsonl (input-
// shaped lines — {key, value, capability?} — written by hook processes
// that know nothing about the server session, so they are REBUILT with the
// current session's identity via buildEvent) and the exit spool's
// exit-events.jsonl (FULL built events written synchronously by
// spoolEventsForExit at process exit, keeping the exiting session's
// identity — parsed strictly via toTelemetryEvent, never rebuilt).
//
// The shared pattern (crash-recovery convergence): ingest any earlier
// .processing leftover first (a crashed run's claim), then rename the live
// spool to .processing for the NEXT ingest to pick up — the rename is the
// claim, so concurrent processes claim disjoint files and writers (hooks,
// exit paths) always append to a fresh live file. Delivery is
// AT-LEAST-ONCE, not exactly-once: a failed unlink after a successful
// read (transient FS error) or a cross-process read inside the read→unlink
// window can re-send a batch — bounded duplicate telemetry, no loss
// (pre-existing semantics for the hook spool, inherited by the exit
// spool). Malformed lines are dropped; an unreadable leftover batch is
// unrecoverable and cleaned up best-effort.
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';

import type { TelemetryContext, TelemetryEvent } from './telemetry-types.ts';
import { buildEvent, MAX_EVENT_QUEUE, toTelemetryEvent, toTelemetryEventInput } from './telemetry-values.ts';

export function ingestSpools(ctx: TelemetryContext): void {
  ingestJsonlSpool(ctx, ctx.paths.hookEventsPath, (parsed) => {
    const input = toTelemetryEventInput(parsed);
    return input ? buildEvent(ctx, input) : null;
  });
  ingestJsonlSpool(ctx, ctx.paths.exitEventsPath, toTelemetryEvent);
}

function ingestJsonlSpool(
  ctx: TelemetryContext,
  livePath: string,
  parseLine: (parsed: unknown) => TelemetryEvent | null,
): void {
  const processingPath = livePath + '.processing';
  if (existsSync(processingPath)) {
    try {
      const lines = readFileSync(processingPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          const event = parseLine(parsed);
          if (event) ctx.state.eventQueue.push(event);
        } catch {
          // a malformed line is skipped; the rest of the leftover batch still ingests
        }
      }
      // Clamp to the shared event-queue cap (keep-newest — the same policy
      // the enqueue path applies), so the ≤cap invariant holds on every
      // writer. Without this, a large recovery (multi-session exit-spool
      // accumulation) loads unbounded events into memory; with it, a
      // recovery larger than the cap drops its OLDEST overflow at read
      // time — truncating what a no-clamp recovery could have fully
      // delivered across later rounds. The memory invariant is the point.
      // Cross-spool note: the hook spool is ingested first, so when both
      // spools are saturated the exit spool (pushed later = newer) wins
      // the tail by push order.
      if (ctx.state.eventQueue.length > MAX_EVENT_QUEUE) {
        ctx.state.eventQueue = ctx.state.eventQueue.slice(-MAX_EVENT_QUEUE);
      }
    } catch {
      // an unreadable leftover batch is unrecoverable; fall through to cleanup
    } finally {
      try {
        unlinkSync(processingPath);
      } catch {
        // best-effort: a failed unlink retries this leftover on the next
        // ingest (at-least-once: the already-pushed events may re-send)
      }
    }
  }
  if (!existsSync(livePath)) return;
  try {
    renameSync(livePath, processingPath);
  } catch {
    return;
  }
}
