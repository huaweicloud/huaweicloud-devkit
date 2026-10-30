// The event pipeline: enqueue (with hook-spool ingestion and the DAU ping),
// the queue caps, the batch flush over fetchWithProxy with timeout and
// bounded retry, the opt-out gate (HUAWEICLOUD_DEVKIT_TELEMETRY=off) and
// the endpoint override, the stamp touches a successful flush performs,
// and the exit-time synchronous disk spool. State arrives via the
// face-owned context.
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { fetchWithProxy } from '../proxy/proxy-agent.ts';
import { checkDauPing } from './identity-stamps.ts';
import { ingestSpools } from './hook-ingest.ts';
import { ensureDir, touchFile } from './telemetry-fs.ts';
import type { TelemetryContext, TelemetryEvent, TelemetryEventInput } from './telemetry-types.ts';
import { buildEvent, MAX_EVENT_QUEUE } from './telemetry-values.ts';

const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

const DEFAULT_ENDPOINT = 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/telemetry/events';

export function isTelemetryEnabled(): boolean {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY !== 'off';
}

function getEndpoint(): string {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

// The body of the public enqueueEvent (re-exported through the face).
export function enqueueTrackedEvent(ctx: TelemetryContext, raw: TelemetryEventInput): void {
  if (!isTelemetryEnabled()) return;
  if (!ctx.state.installId) return;

  ingestSpools(ctx);

  checkDauPing(ctx);

  const event = buildEvent(ctx, raw);
  ctx.state.eventQueue.push(event);

  if (ctx.state.eventQueue.length > MAX_EVENT_QUEUE) {
    ctx.state.eventQueue = ctx.state.eventQueue.slice(ctx.state.eventQueue.length - MAX_EVENT_QUEUE);
  }

  if (ctx.state.eventQueue.length >= BATCH_SIZE)
    setImmediate(() => {
      void flushEvents(ctx);
    });
}

// The awaitable flush. ONE round per call (a round = one BATCH_SIZE splice
// over the wire, exactly the pre-awaitable behavior per trigger), so a
// trigger arriving while the pipeline is IDLE keeps its pacing — a round
// failing with a retryable error still waits for the next trigger. One
// deliberate pacing change from the pre-awaitable void: a trigger arriving
// while a round is IN FLIGHT previously no-op'd; it now chains into a
// follow-up round, so under sustained ≥BATCH_SIZE enqueue pressure against
// a dead endpoint, retry rounds run denser than the old
// one-round-per-trigger spacing (still bounded — the retry budget drops
// the events after MAX_RETRIES either way).
//
// Await semantics for a caller arriving while a round is in flight (the
// documented contract, pinned by test/telemetry.test.ts): the caller
// chains onto the in-flight round and then gets ONE follow-up round for
// the remainder — events enqueued after the in-flight splice (the awaiter's
// own, typically) still get a real send attempt before the promise
// resolves. The recursion terminates: each follow-up only happens on an
// in-flight arrival, and a round permanently removes its batch (sent or
// client-error dropped) or requeues it with _retries+1 until MAX_RETRIES
// drops it, so the queue strictly drains under a chain. Wait bound, stated
// honestly: the chain's DEPTH scales with arrivals — each in-flight
// collision adds one follow-up round, so K awaiters arriving mid-flight
// serialize into up to K+1 rounds, and under sustained traffic against a
// dead endpoint an awaiter's wait scales with the arrival rate, not with
// the retry budget. What the budget bounds is each BATCH's delivery
// lifetime (a requeued batch is dropped after MAX_RETRIES failing rounds,
// ≤ 4 fetch timeouts old) — which guarantees termination, not a latency
// ceiling. A queue longer than the follow-up's batch leaves the tail to
// the next trigger — the exit spool (hook-ingest.ts) owns that tail, not
// this promise.
//
// The returned promise never rejects: failures (fetch errors, 5xx) are
// dispositioned internally (requeue for the next trigger, or drop after
// MAX_RETRIES); awaiting consumers (the voucher P0 flush) must never see a
// telemetry failure surface.
export function flushEvents(ctx: TelemetryContext): Promise<void> {
  if (ctx.state.isFlushing) {
    const inflight = ctx.state.inflightFlush ?? Promise.resolve();
    return inflight.then(() => flushEvents(ctx));
  }
  if (ctx.state.eventQueue.length === 0) return Promise.resolve();
  return startFlushRound(ctx);
}

function startFlushRound(ctx: TelemetryContext): Promise<void> {
  ctx.state.isFlushing = true;
  // Assigned after startFlushRound's synchronous prologue — safe because
  // runFlushRound is an async function whose settlement is always a
  // microtask, which cannot run before this assignment completes.
  const round = runFlushRound(ctx).finally(() => {
    ctx.state.isFlushing = false;
    ctx.state.inflightFlush = null;
  });
  ctx.state.inflightFlush = round;
  return round;
}

async function runFlushRound(ctx: TelemetryContext): Promise<void> {
  const batch = ctx.state.eventQueue.splice(0, BATCH_SIZE);
  const keys = batch.map((e) => e.key).join(',');
  // The queue was checked non-empty by the caller; splice yields a
  // non-empty batch.
  ctx.debugLog(
    `FLUSH start events=${batch.length} harness=${batch[0]!.harness} agentVersion=${batch[0]!.agentVersion} keys=[${keys}]`,
  );

  const endpoint = getEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetchWithProxy(endpoint, {
      method: 'POST',
      // #1040: 对外上报统一携带 X-HW-Agent（值=initTelemetry 缓存的
      // harness，未初始化会话读 state 的 'unknown' 默认值）。
      headers: { 'Content-Type': 'application/json', 'X-HW-Agent': ctx.state.agentHarness || 'unknown' },
      body: JSON.stringify(batch.map(({ _retries, ...rest }) => rest)),
      signal: controller.signal,
    });
    ctx.debugLog(`POST status=${resp.status} events=${batch.length}`);
    if (resp.ok) {
      for (const event of batch) {
        if (event.key === 'dau:active_today') touchFile(ctx.paths.dauStampPath);
        if (event.key === 'plugin:install') touchFile(ctx.paths.installStampPath);
        if (event.key === 'plugin:first_use') touchFile(ctx.paths.firstUseStampPath);
      }
    } else if (resp.status >= 400 && resp.status < 500) {
      ctx.debugLog(`POST status=${resp.status} dropping ${batch.length} events (client error)`);
    } else {
      requeueEvents(ctx, batch);
    }
  } catch (error: unknown) {
    ctx.debugLog(`POST FAIL err=${error instanceof Error ? error.message : String(error)} events=${batch.length}`);
    requeueEvents(ctx, batch);
  } finally {
    clearTimeout(timer);
  }
}

function requeueEvents(ctx: TelemetryContext, batch: TelemetryEvent[]): void {
  const kept: TelemetryEvent[] = [];
  for (const event of batch) {
    const retries = event._retries || 0;
    if (retries >= MAX_RETRIES) {
      ctx.debugLog(`DROP event key=${event.key} after ${MAX_RETRIES} retries`);
      continue;
    }
    event._retries = retries + 1;
    kept.push(event);
  }
  if (kept.length > 0) ctx.state.eventQueue = [...kept, ...ctx.state.eventQueue];
}

// The exit-time synchronous disk spool (E4b). The stdio transport's close
// paths call this immediately before exit: process.exit runs no further
// event-loop turns, so an async flush cannot live there (beforeExit never
// fires on explicit exit, and awaiting a 5s fetch inside onStdinClose
// risks the host's CLOSE_TIMEOUT). The queue is written as full-event
// JSONL to exit-events.jsonl (global telemetry dir — it must survive
// plugin updates that replace the payload dir, and it follows
// HUAWEICLOUD_DEVKIT_HOME for isolation), then CLEARED: the spool copy is
// the handover, so a path that outlives the spool (the stdout-close
// natural drain, where a straggler timer flush may still fire) finds an
// empty queue and cannot double-send the spooled lines. Append mode keeps
// concurrent sessions — separate processes sharing the home — from
// clobbering each other's tails; the boot-time ingest (ingestSpools)
// claims the file with the same rename-now/read-next pattern as the hook
// spool, so a crash between write and ingest is recovered exactly once.
//
// Idempotence when both close paths fire in one process (stdout close,
// then the hard stdin exit): the first call clears the queue, so the
// second appends only events enqueued in between — each line is written
// exactly once. An in-flight flush round at spool time is NOT captured
// (its batch already left the queue, mid-send): on the hard-exit path it
// is abandoned (≤ BATCH_SIZE events inside one 5s fetch window — the
// pre-E4b behavior, no regression); on the natural-drain path it may
// still complete on its own. A failed round requeues into the now-empty
// queue and is lost at drain — both are accepted, bounded, documented
// residuals (see docs/CHANGELOG.md).
//
// Recovery timing is NEXT ACTIVE BOOT, not literally next boot: a boot
// that enqueues nothing (all stamps present, counter zero — the steady
// state) only CLAIMS the spool via the rename; the first tool-call
// enqueue's ingest or the 60s timer tick reads it. An idle session that
// exits before either defers recovery to the following boot — no loss,
// convergent, but one extra idle lifetime of latency. Crash windows
// (between append and rename, rename and read, read and unlink) all
// converge to at-least-once delivery; a crash BEFORE any close handler
// runs (SIGKILL-class) loses the in-memory tail — no handler runs at all.
export function spoolEventsForExit(ctx: TelemetryContext): void {
  const queue = ctx.state.eventQueue;
  if (queue.length === 0) return;
  try {
    ensureDir(dirname(ctx.paths.exitEventsPath));
    appendFileSync(ctx.paths.exitEventsPath, `${queue.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    ctx.debugLog(`EXIT SPOOL wrote ${queue.length} events to ${ctx.paths.exitEventsPath}`);
    ctx.state.eventQueue = [];
  } catch (error: unknown) {
    // best-effort: a failed spool loses the tail; it must never block the exit
    ctx.debugLog(`EXIT SPOOL FAIL err=${error instanceof Error ? error.message : String(error)}`);
  }
}
