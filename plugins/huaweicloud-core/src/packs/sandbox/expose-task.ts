import { randomUUID } from 'node:crypto';

import type { ExposeTunnelResult } from '../../sandbox/devbridge-expose.ts';

// The async expose-task registry (AX N-SB.1). An expose chain can outlive
// the host's MCP request timeout (auth gate + selective cleanups + up to
// four ~63s expose execs + the persistence re-verify + keepalive enrollment)
// while the server completes it — the synchronous tool then loses the
// publicUrl. An async start returns immediately and the poll tool delivers
// the finished result in-band.
//
// The registry is process-scoped (the stdio MCP server owns one). A restart
// loses the receipt while the tunnel may already live; the unknown hint
// therefore teaches recovery (re-expose / deploy_check) and never fabricates
// a URL. Entries are swept after the TTL so a long session cannot grow the
// map unbounded.

export const EXPOSE_TASK_ID_PATTERN = /^exp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXPOSE_TASK_TTL_MS = 30 * 60_000;

export interface ExposeTaskSnapshot {
  startedAt: number;
  workspaceId: string;
  port: number;
}

type ExposeTask =
  | (ExposeTaskSnapshot & { state: 'running' })
  | (ExposeTaskSnapshot & { state: 'done'; result: ExposeTunnelResult })
  | (ExposeTaskSnapshot & { state: 'failed'; error: string });

const tasks = new Map<string, ExposeTask>();

function sweep(now: number): void {
  for (const [taskId, task] of tasks) {
    if (now - task.startedAt > EXPOSE_TASK_TTL_MS) tasks.delete(taskId);
  }
}

export function startExposeTask(
  workspaceId: string,
  port: number,
  run: () => Promise<ExposeTunnelResult>,
): { taskId: string; startedAt: number } {
  const now = Date.now();
  sweep(now);
  const taskId = `exp-${randomUUID()}`;
  const snapshot: ExposeTaskSnapshot = { startedAt: now, workspaceId, port };
  tasks.set(taskId, { ...snapshot, state: 'running' });
  // The chain runs detached from the tool call: the client may time out or
  // cancel the start request, but the server-side work (and the tunnel it
  // creates) must continue. Both settle paths are recorded, so the promise
  // is never an unhandled rejection.
  void run().then(
    (result) => {
      tasks.set(taskId, { ...snapshot, state: 'done', result });
    },
    (error: unknown) => {
      tasks.set(taskId, {
        ...snapshot,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return { taskId, startedAt: now };
}

export type ExposePollResult =
  | { state: 'running'; elapsedMs: number; hint: string }
  | { state: 'done'; result: ExposeTunnelResult }
  | { state: 'failed'; error: string }
  | { state: 'unknown'; hint: string };

export function pollExposeTask(taskId: string): ExposePollResult {
  const now = Date.now();
  sweep(now);
  const task = tasks.get(taskId);
  if (!task) {
    return {
      state: 'unknown',
      hint:
        'No task with this id is known to this MCP server process (it never started here, the session restarted, or the ' +
        '30-minute receipt expired). The tunnel may already exist: run huaweicloud_sandbox_deploy_check to read it, or ' +
        're-run huaweicloud_sandbox_expose_tunnel (same port) — do not assume success without a URL.',
    };
  }
  if (task.state === 'running') {
    return {
      state: 'running',
      elapsedMs: now - task.startedAt,
      hint: 'The expose chain is running in the background (auth, cleanup, host start, health check, keepalive). Call again.',
    };
  }
  if (task.state === 'done') {
    return { state: 'done', result: task.result };
  }
  return { state: 'failed', error: task.error };
}

// Test seam: isolate a process-global registry between cases.
export function _resetExposeTasksForTests(): void {
  tasks.clear();
}
