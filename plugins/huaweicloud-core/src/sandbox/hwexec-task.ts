import { randomBytes } from 'node:crypto';

import { asText } from '../lib/as-text.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';

// The async sandbox-task family — the claim protocol as formalized and
// TLC-verified (the HwExecClaim spec, 9/9 invariants). One directory per
// task, /tmp/.hwexec/<taskId>/, whose files ARE the state:
//   claim    — the start script's O_EXCL create; existence means some start
//              already won the spawn right, so a retry is structurally
//              unable to spawn a second copy.
//   cmd      — the original command line (diagnostics only; poll never
//              reads it; a retry rewrite is harmless).
//   launched — the wrapper's first-action guard file, separating never
//              (claimed, never spawned) from lost (ran, died without
//              writing a status).
//   log      — the command's stdout+stderr append stream.
//   status   — the terminal `exit:<n>` line; the write is non-atomic, so a
//              torn read must converge to running — the field is matched by
//              CONTENT (full `exit:<digits>` line), never by existence.
// The claim's deliberate trade: an exec that dies between claim and spawn
// leaves a task that never runs, and no same-id retry can recover it — the
// poll's `never` verdict is exactly that state, and the teaching is a NEW
// task_id. The guard-file variant (check `launched` before spawning — the
// HwExecGuard3 spec) is falsified by OneCopyRunning (Start, then a retry
// inside the unconfirmed window, runs two copies); never reintroduce any
// pre-spawn launched check — the O_EXCL claim create is the only spawn
// arbiter, and the elif after it only classifies the create failure.

// Server-side truth root, one directory per task. /tmp is session-scoped: a
// sandbox reboot wipes it — the poll's lost/unknown split models exactly
// that boundary.
export const HWEXEC_TASK_ROOT = '/tmp/.hwexec';

// Task ids are path- and pgrep-safe by charset (lowercase, digits, hyphen,
// 1-64 chars): they ride file paths AND the pgrep -f pattern, so no shell
// metacharacter can ever travel through one.
export const HWEXEC_TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The poll's bounded wait: sleep-2 intervals checking the status file; the
// loop count is folded from wait_ms.
export const HWEXEC_WAIT_STEP_MS = 2000;

// The wait_ms ceiling (the zod text and the validator both read this).
export const HWEXEC_WAIT_MS_MAX = 60000;

// Default log-tail size for a poll (and the dup receipt's verdict poll).
export const HWEXEC_TAIL_BYTES_DEFAULT = 4096;

// Log-tail ceiling: the tail rides the poll exec's stdout, and the exec
// channel is fragile for large single payloads — it stays bounded.
export const HWEXEC_TAIL_BYTES_MAX = 65536;

// The poll exec's headroom over wait_ms (the devbridge-expose-flow A2
// budget doctrine): the bounded wait plus the field round-trips must sit
// INSIDE the ws-exec timeout, so the effective timeout folds to
// wait_ms + 15s and the wait loop can never die as a mid-exec timeout.
export const HWEXEC_POLL_HEADROOM_MS = 15000;

export function hwexecTaskDir(taskId: string): string {
  return `${HWEXEC_TASK_ROOT}/${taskId}`;
}

// Validate a task id destined for path and pgrep-pattern interpolation.
export function validateHwexecTaskId(id: unknown): string {
  const value = asText(id ?? '');
  if (!HWEXEC_TASK_ID_PATTERN.test(value)) {
    throw new Error(
      `sandbox exec: invalid task_id ${JSON.stringify(value.slice(0, 40))}. ` +
        `Expected ${HWEXEC_TASK_ID_PATTERN.source} (path- and pgrep-safe); omit task_id to let the tool generate one.`,
    );
  }
  return value;
}

// Generate a task id (t-<12 hex>). Collision resistance within one sandbox
// session is the only requirement — ids scope per-task directories.
export function generateHwexecTaskId(): string {
  return `t-${randomBytes(6).toString('hex')}`;
}

// Escape a command line for embedding inside a shell single-quoted span —
// both the cmd-file write and the wrapper's sh -c splice the command this
// way (close quote, escaped quote, reopen).
export function escapeHwexecCommand(command: string): string {
  return command.replaceAll("'", "'\\''");
}

// The start script: claim → spawn → receipt, in that line order. The O_EXCL
// claim create is the only spawn arbiter; the elif only classifies the
// create failure (dup vs error) and never gates the spawn. The wrapper
// writes the launched guard as its FIRST action, appends the command's
// stdout+stderr to the log, then commits `exit:<n>`.
export function buildHwexecStartScript(taskId: string, command: string): string {
  const id = validateHwexecTaskId(taskId);
  const dir = hwexecTaskDir(id);
  const escaped = escapeHwexecCommand(command);
  // The wrapper's sh -c does not inherit the outer shell's variables, and
  // poll liveness is detected by pgrep -f matching the literal
  // <dir>/launched path inside the wrapper's own command line — so the
  // wrapper's paths are inlined, never $D-expanded.
  const wrapper = `: > "${dir}/launched"; ( ${escaped} ) >> "${dir}/log" 2>&1; echo "exit:$?" > "${dir}/status"`;
  return [
    `D=${dir}`,
    `mkdir -p "$D"`,
    `printf '%s\\n' '${escaped}' > "$D/cmd"`,
    `if (set -C; : > "$D/claim") 2>/dev/null; then`,
    // #919/#922 (the devbridge-expose trio): setsid detaches the process
    // group so the task survives the exec session's teardown, < /dev/null
    // drops the controlling tty, disown removes the job-table entry. A
    // missing setsid falls back to a bare nohup launch — the task still
    // starts; disown is guarded so shells without the builtin survive.
    `  if command -v setsid > /dev/null 2>&1; then setsid nohup sh -c '${wrapper}' >/dev/null 2>&1 < /dev/null & else nohup sh -c '${wrapper}' >/dev/null 2>&1 < /dev/null & fi`,
    `  disown 2>/dev/null || true`,
    `  echo "HW_STARTED=${id}"`,
    `elif [ -f "$D/claim" ]; then`,
    `  echo "HW_DUP=${id}"`,
    `else`,
    `  echo "HW_CLAIM_ERROR=1"`,
    `fi`,
  ].join('\n');
}

// Fold wait_ms into the bounded-wait loop count. Floor division keeps the
// total sleep ≤ wait_ms — the budget the exec timeout is folded from.
export function hwexecPollLoops(waitMs: number): number {
  return Math.floor(waitMs / HWEXEC_WAIT_STEP_MS);
}

// Validate wait_ms (0-60000, integer; the default is 0 — no in-poll wait).
export function validateHwexecWaitMs(waitMs: unknown): number {
  const n = Number(waitMs ?? 0);
  if (!Number.isSafeInteger(n) || n < 0 || n > HWEXEC_WAIT_MS_MAX) {
    throw new Error(
      `sandbox exec poll: invalid wait_ms ${JSON.stringify(waitMs)}. ` +
        `Expected an integer between 0 and ${HWEXEC_WAIT_MS_MAX}.`,
    );
  }
  return n;
}

// Validate tail_bytes (1-65536; the default is 4096).
export function validateHwexecTailBytes(tailBytes: unknown): number {
  const n = Number(tailBytes ?? HWEXEC_TAIL_BYTES_DEFAULT);
  if (!Number.isSafeInteger(n) || n < 1 || n > HWEXEC_TAIL_BYTES_MAX) {
    throw new Error(
      `sandbox exec poll: invalid tail_bytes ${JSON.stringify(tailBytes)}. ` +
        `Expected an integer between 1 and ${HWEXEC_TAIL_BYTES_MAX}.`,
    );
  }
  return n;
}

// The poll exec timeout: wait_ms + headroom, never below the table default.
// A timeout on a poll must mean the sandbox is unreachable — never that the
// script's own bounded wait ran out of clock.
export function resolveHwexecPollTimeoutMs(waitMs: number, baseTimeoutMs: number): number {
  return Math.max(baseTimeoutMs, waitMs + HWEXEC_POLL_HEADROOM_MS);
}

// The poll script: a bounded wait (sleep-2 intervals, loop count folded from
// wait_ms, early exit the moment the status line commits), then the one-shot
// field echo. The HW_* fields are read only from the region before
// HW_LOG_BEGIN, so log content can never line-inject a verdict field.
export function buildHwexecPollScript(taskId: string, waitMs: number, tailBytes: number): string {
  const id = validateHwexecTaskId(taskId);
  const loops = hwexecPollLoops(validateHwexecWaitMs(waitMs));
  const bytes = validateHwexecTailBytes(tailBytes);
  return [
    // #999-class guard: the pgrep pattern is assembled from concatenated
    // quoted fragments, so its VALUE never appears literally in this
    // script's own text — a shell whose command line carries the script
    // (an sh -c wrapper) can never match itself. The /launched suffix
    // anchors the pattern to THIS task's wrapper: a bare hwexec/<id>
    // prefix would also match hwexec/<id>-suffix sibling tasks and break
    // the per-task independence the claim protocol's model assumes.
    `P="hwexec/""${id}""/launched"`,
    `D="/tmp/"".hwexec/""${id}"`,
    `i=0`,
    `while [ "$i" -lt ${loops} ]; do`,
    `  grep -q '^exit:[0-9][0-9]*$' "$D/status" 2>/dev/null && break`,
    `  sleep 2`,
    `  i=$((i+1))`,
    `done`,
    `if [ -d "$D" ]; then echo "HW_DIR=1"; else echo "HW_DIR=0"; fi`,
    `S=$(grep -m1 '^exit:[0-9][0-9]*$' "$D/status" 2>/dev/null || true)`,
    `echo "HW_STATUS=$S"`,
    // Missing pgrep (a procps-less image) must not read as dead: an
    // unprobeable aliveness fails SAFE toward alive, because a false
    // 'lost' verdict would send the caller to a new task_id while a copy
    // still runs — the one direction the claim protocol exists to make
    // impossible. The verdict still converges: the task's own completion
    // writes the status file.
    `if command -v pgrep > /dev/null 2>&1 && pgrep -f "$P" > /dev/null 2>&1; then echo "HW_ALIVE=1"; elif command -v pgrep > /dev/null 2>&1; then echo "HW_ALIVE=0"; else echo "HW_ALIVE=1"; fi`,
    `if [ -f "$D/launched" ]; then echo "HW_LAUNCHED=1"; else echo "HW_LAUNCHED=0"; fi`,
    `echo "HW_LOG_BEGIN"`,
    `tail -c ${bytes} "$D/log" 2>/dev/null`,
    `echo "HW_LOG_END"`,
  ].join('\n');
}

// The observable facts one poll reads off the task directory — parsed at
// the boundary, never re-derived from raw stdout downstream.
export interface HwexecPollFacts {
  dir: boolean;
  status: string;
  alive: boolean;
  launched: boolean;
  logTail: string;
}

// The judgment label (the verdict table's five states).
export type HwexecVerdictName = 'done' | 'running' | 'lost' | 'never' | 'unknown';

// The judgment the facts induce, as a discriminated union:
//   dir absent   → knowTask ? lost (the sandbox rebooted) : unknown
//   status exit: → done (exitCode, logTail)
//   alive        → running (logTail)
//   launched     → lost (the wrapper died without an exit status)
//   otherwise    → never (claimed; the exec died before the spawn)
export type HwexecVerdict =
  | { verdict: 'done'; exitCode: number; logTail: string }
  | { verdict: 'running'; logTail: string }
  | { verdict: 'lost'; logTail: string }
  | { verdict: 'never' }
  | { verdict: 'unknown' };

export function deriveHwexecVerdict(facts: HwexecPollFacts, knowTask: boolean): HwexecVerdict {
  if (!facts.dir) {
    // logTail is '' here by construction: the script's tail on a missing
    // directory produces nothing — the field stays uniform for consumers.
    return knowTask ? { verdict: 'lost', logTail: facts.logTail } : { verdict: 'unknown' };
  }
  const exitMatch = facts.status.match(/^exit:(\d+)$/);
  if (exitMatch) {
    return { verdict: 'done', exitCode: Number(exitMatch[1]), logTail: facts.logTail };
  }
  if (facts.alive) {
    return { verdict: 'running', logTail: facts.logTail };
  }
  if (facts.launched) {
    return { verdict: 'lost', logTail: facts.logTail };
  }
  return { verdict: 'never' };
}

const HW_LOG_BEGIN_MARKER = 'HW_LOG_BEGIN';
const HW_LOG_END_MARKER = 'HW_LOG_END';

// Anchored ^KEY= reader over a field region — the HW_* grammar's single
// lookup rule (the readDbField doctrine). Returns undefined when the field
// is absent, so presence and value stay distinguishable.
function readHwField(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m === null ? undefined : (m[1] ?? '').trim();
}

// Parse one poll exec's stdout into the facts. #946: strip OSC/CSI escapes
// and \r before the anchored lookups. The four verdict fields are
// presence-required — the script emits them unconditionally, so a missing
// field means the output was truncated or garbled, and an unreadable poll
// must FAIL instead of misjudging: a defaulted 'never'/'lost' would send
// the caller to a new task_id while a copy still runs.
export function parseHwexecPollOutput(stdout: unknown): HwexecPollFacts {
  const text = stripTerminalEscapes(stdout);
  const beginIdx = text.indexOf(HW_LOG_BEGIN_MARKER);
  const head = beginIdx === -1 ? text : text.slice(0, beginIdx);
  let logTail = '';
  if (beginIdx !== -1) {
    const afterBegin = text.slice(beginIdx + HW_LOG_BEGIN_MARKER.length);
    const endIdx = afterBegin.indexOf(HW_LOG_END_MARKER);
    const raw = endIdx === -1 ? afterBegin : afterBegin.slice(0, endIdx);
    logTail = raw.replace(/^\n/, '').replace(/\n$/, '');
  }
  const required = (key: string): string => {
    const value = readHwField(head, key);
    if (value === undefined) {
      throw new Error(
        `sandbox exec poll: unreadable output — the ${key} field is missing, so no verdict can be derived; retry the poll.`,
      );
    }
    return value;
  };
  return {
    dir: required('HW_DIR') === '1',
    status: required('HW_STATUS'),
    alive: required('HW_ALIVE') === '1',
    launched: required('HW_LAUNCHED') === '1',
    logTail,
  };
}

// Classify the start exec's stdout into the receipt outcome. No matching
// field (truncated or garbled output) reads as 'uncertain' — the receipt
// was lost, which is exactly what the same-task_id retry ladder covers.
export type HwexecStartOutcomeKind = 'started' | 'uncertain' | 'dup' | 'claim_error';

export function classifyHwexecStartOutput(stdout: unknown, taskId: string): HwexecStartOutcomeKind {
  const text = stripTerminalEscapes(stdout);
  if (readHwField(text, 'HW_STARTED') === taskId) return 'started';
  if (readHwField(text, 'HW_DUP') === taskId) return 'dup';
  if (readHwField(text, 'HW_CLAIM_ERROR') === '1') return 'claim_error';
  return 'uncertain';
}
