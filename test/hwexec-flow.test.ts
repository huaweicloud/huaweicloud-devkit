import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  handleHwexecPoll,
  startHwexecTask,
} from '../plugins/huaweicloud-core/src/packs/sandbox/handlers-hwexec.ts';
import { handleExecOneShot } from '../plugins/huaweicloud-core/src/packs/sandbox/handlers-session.ts';

// End-to-end handler behavior over the module-local one-shot seam (the
// a965639e / devbridge-exec.ts precedent): the seam models the SERVER —
// start scripts O_EXCL-claim per task id (second start → HW_DUP), poll
// scripts answer whatever verdict state the test wants. The claim-blocking
// and uncertain-retry pins below are the protocol's safety cases: no
// sequence of client calls may ever produce a second spawn.
process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';

const WS = 'ws-hwexec-flow';
const USER = 'root';

function timeoutError(): Error {
  // The ws-exec timeout shape (hwlink-exec-session.ts): exitCode 124.
  return Object.assign(new Error('hwlink terminal exec timeout after 30000ms'), { exitCode: 124 });
}

function startStdoutFor(taskId: string): string {
  return `HW_STARTED=${taskId}\n`;
}

function dupStdoutFor(taskId: string): string {
  return `HW_DUP=${taskId}\n`;
}

function pollStdout(fields: { dir?: 1 | 0; status?: string; alive?: 1 | 0; launched?: 1 | 0; log?: string }): string {
  return [
    `HW_DIR=${fields.dir ?? 1}`,
    `HW_STATUS=${fields.status ?? ''}`,
    `HW_ALIVE=${fields.alive ?? 0}`,
    `HW_LAUNCHED=${fields.launched ?? 0}`,
    'HW_LOG_BEGIN',
    fields.log ?? '',
    'HW_LOG_END',
    '',
  ].join('\n');
}

// A seam that models the server-side O_EXCL claim: the first start script
// for a task id wins the claim (HW_STARTED), any later one reads HW_DUP.
// Poll scripts are answered by the poller callback. Every received script
// is recorded for shape assertions.
function claimingSeam(poller: (taskId: string) => string) {
  const claimed = new Set<string>();
  const scripts: string[] = [];
  const timeouts: number[] = [];
  _setOneShotForTests(async (_ws, command, _username, timeoutMs) => {
    scripts.push(command);
    timeouts.push(timeoutMs);
    const startId = /^D=\/tmp\/\.hwexec\/([a-z0-9][a-z0-9-]{0,63})$/.exec(command.split('\n', 1)[0] ?? '');
    if (startId) {
      const taskId = startId[1]!;
      if (claimed.has(taskId)) return { stdout: dupStdoutFor(taskId), exitCode: 0 };
      claimed.add(taskId);
      return { stdout: startStdoutFor(taskId), exitCode: 0 };
    }
    const pollId = /^P="hwexec\/""([a-z0-9-]+)""\/launched"$/.exec(command.split('\n', 1)[0] ?? '');
    assert.ok(pollId, `seam received an unrecognized script:\n${command.slice(0, 200)}`);
    return { stdout: poller(pollId[1]!), exitCode: 0 };
  });
  return {
    scripts,
    timeouts,
    restore: () => _setOneShotForTests(null),
  };
}

test('hwexec start: a won claim returns started:true with the task receipt', async () => {
  const seam = claimingSeam(() => pollStdout({}));
  try {
    const result = await startHwexecTask({ command: 'npm run build', task_id: 'flow-start-1' }, WS, USER);
    assert.deepEqual(
      { ...result, hint: 'x' },
      { started: true, taskId: 'flow-start-1', taskDir: '/tmp/.hwexec/flow-start-1', hint: 'x' },
    );
    assert.match((result as { hint: string }).hint, /huaweicloud_sandbox_exec_poll/);
    // The start exec got the async-start budget from the table.
    assert.equal(seam.timeouts[0], 30000);
    // The script the server received is the claim-protocol start script.
    assert.match(seam.scripts[0]!, /if \(set -C; : > "\$D\/claim"\) 2>\/dev\/null; then/);
    assert.match(seam.scripts[0]!, /echo "HW_STARTED=flow-start-1"/);
  } finally {
    seam.restore();
  }
});

test('hwexec start: task ids are validated and generated ids match the safe charset', async () => {
  await assert.rejects(startHwexecTask({ command: 'true', task_id: 'BAD' }, WS, USER), /invalid task_id/);
  const seam = claimingSeam(() => pollStdout({}));
  try {
    const generated = (await startHwexecTask({ command: 'true' }, WS, USER)) as { taskId: string };
    assert.match(generated.taskId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  } finally {
    seam.restore();
  }
});

test('hwexec start: a start-exec timeout returns started:"uncertain" (the claim may have landed)', async () => {
  const scripts: string[] = [];
  _setOneShotForTests(async (_ws, command) => {
    scripts.push(command);
    throw timeoutError();
  });
  try {
    const result = await startHwexecTask({ command: 'npm run build', task_id: 'flow-unc-1' }, WS, USER);
    assert.equal(result.started, 'uncertain');
    assert.equal((result as { taskId: string }).taskId, 'flow-unc-1');
    assert.match((result as { hint: string }).hint, /SAME task_id/);
    // The timeout was folded to the async-start table default.
    assert.equal(scripts.length, 1);
  } finally {
    _setOneShotForTests(null);
  }
});

test('hwexec start: a NON-timeout exec error propagates (no fabricated receipt)', async () => {
  _setOneShotForTests(async () => {
    throw new Error('tunnel session WebSocket closed');
  });
  try {
    await assert.rejects(startHwexecTask({ command: 'true', task_id: 'flow-err-1' }, WS, USER), /WebSocket closed/);
  } finally {
    _setOneShotForTests(null);
  }
});

test('hwexec claim blocks the second spawn: an uncertain retry gets dup, never a second start', async () => {
  // The ladder end-to-end: start times out (uncertain — the claim MAY have
  // landed server-side), the retry with the SAME task_id hits the claim and
  // reads HW_DUP. The seam models the O_EXCL truth: one claim per id, ever.
  const claimed = new Set<string>();
  let phase = 'timeout';
  const scripts: string[] = [];
  _setOneShotForTests(async (_ws, command) => {
    scripts.push(command);
    const startId = /^D=\/tmp\/\.hwexec\/([a-z0-9][a-z0-9-]{0,63})$/.exec(command.split('\n', 1)[0] ?? '');
    if (!startId) return { stdout: pollStdout({ status: 'exit:0' }), exitCode: 0 };
    const taskId = startId[1]!;
    if (phase === 'timeout') {
      claimed.add(taskId);
      phase = 'claimed';
      throw timeoutError();
    }
    // The retry: the claim already exists server-side.
    assert.ok(claimed.has(taskId), 'the retry must reuse the SAME task id');
    return { stdout: dupStdoutFor(taskId), exitCode: 0 };
  });
  try {
    const uncertain = await startHwexecTask({ command: 'npm run build', task_id: 'flow-dup-1' }, WS, USER);
    assert.equal(uncertain.started, 'uncertain');
    const retry = await startHwexecTask({ command: 'npm run build', task_id: 'flow-dup-1' }, WS, USER);
    assert.equal(retry.started, 'dup');
    // BOTH start scripts carried the same O_EXCL claim idiom — the second
    // call did not (and structurally cannot) spawn: the server's claim file
    // is the only arbiter, and it exists.
    assert.equal(scripts.length, 3, 'start + retry start + the dup verdict poll');
    for (const script of scripts.slice(0, 2)) {
      assert.match(script, /if \(set -C; : > "\$D\/claim"\) 2>\/dev\/null; then/);
      assert.match(script, /setsid nohup sh -c/);
    }
  } finally {
    _setOneShotForTests(null);
  }
});

test('hwexec dup receipt carries the current verdict, and never teaches a same-id retry', async () => {
  // dup + never → the receipt's hint MUST point at a NEW task_id (the
  // claim's trade: that task can never spawn again).
  const seam = claimingSeam(() => pollStdout({ status: '', alive: 0, launched: 0 }));
  try {
    // First start claims the id; the retry reads the dup + never verdict.
    await startHwexecTask({ command: 'npm run build', task_id: 'flow-never-1' }, WS, USER);
    const retry = (await startHwexecTask({ command: 'npm run build', task_id: 'flow-never-1' }, WS, USER)) as {
      started: string;
      verdict: string;
      hint?: string;
    };
    assert.equal(retry.started, 'dup');
    assert.equal(retry.verdict, 'never');
    assert.match(retry.hint ?? '', /NEW task_id/);
  } finally {
    seam.restore();
  }
  // dup + done hands the result over immediately.
  const doneSeam = claimingSeam(() => pollStdout({ status: 'exit:0', launched: 1, log: 'build ok' }));
  try {
    await startHwexecTask({ command: 'npm run build', task_id: 'flow-done-1' }, WS, USER);
    const retry = (await startHwexecTask({ command: 'npm run build', task_id: 'flow-done-1' }, WS, USER)) as {
      started: string;
      verdict: string;
      exitCode?: number;
      logTail?: string;
    };
    assert.equal(retry.verdict, 'done');
    assert.equal(retry.exitCode, 0);
    assert.equal(retry.logTail, 'build ok');
  } finally {
    doneSeam.restore();
  }
});

test('hwexec start: HW_CLAIM_ERROR returns ok:false (the task was not started)', async () => {
  _setOneShotForTests(async () => ({ stdout: 'HW_CLAIM_ERROR=1\n', exitCode: 0 }));
  try {
    const result = (await startHwexecTask({ command: 'true', task_id: 'flow-cerr-1' }, WS, USER)) as {
      ok?: boolean;
      taskId: string;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.taskId, 'flow-cerr-1');
    assert.match(result.error, /claim failed/);
  } finally {
    _setOneShotForTests(null);
  }
});

test('hwexec poll: the verdict table end-to-end over the seam (four states plus never)', async () => {
  const verdictOutput = pollStdout({ status: 'exit:3', launched: 1, log: 'fail log' });
  const seam = claimingSeam(() => verdictOutput);
  try {
    const done = (await handleHwexecPoll({ task_id: 'flow-poll-1', workspace_id: WS })) as {
      verdict: string;
      exitCode?: number;
      logTail?: string;
      taskDir: string;
    };
    assert.equal(done.verdict, 'done');
    assert.equal(done.exitCode, 3);
    assert.equal(done.logTail, 'fail log');
    assert.equal(done.taskDir, '/tmp/.hwexec/flow-poll-1');
  } finally {
    seam.restore();
  }
  const runningSeam = claimingSeam(() => pollStdout({ status: '', alive: 1, launched: 1, log: 'partial' }));
  try {
    const running = (await handleHwexecPoll({ task_id: 'flow-poll-1', workspace_id: WS })) as {
      verdict: string;
      logTail?: string;
    };
    assert.equal(running.verdict, 'running');
    assert.equal(running.logTail, 'partial');
  } finally {
    runningSeam.restore();
  }
  const lostSeam = claimingSeam(() => pollStdout({ status: '', alive: 0, launched: 1 }));
  try {
    const lost = (await handleHwexecPoll({ task_id: 'flow-poll-1', workspace_id: WS })) as { verdict: string };
    assert.equal(lost.verdict, 'lost');
  } finally {
    lostSeam.restore();
  }
  const neverSeam = claimingSeam(() => pollStdout({ status: '', alive: 0, launched: 0 }));
  try {
    const never = (await handleHwexecPoll({ task_id: 'flow-poll-1', workspace_id: WS })) as {
      verdict: string;
      hint: string;
    };
    assert.equal(never.verdict, 'never');
    assert.match(never.hint, /NEW task_id/);
  } finally {
    neverSeam.restore();
  }
});

test('hwexec poll: lost vs unknown splits on the advisory memory, never on correctness-critical state', async () => {
  // A task this process started (the memory remembers it) whose directory
  // is gone → lost (the sandbox rebooted). A task this process never saw →
  // unknown. Poll correctness itself depends on neither: both polls ran.
  const gone = pollStdout({ dir: 0, status: '', alive: 0, launched: 0 });
  const seam = claimingSeam(() => gone);
  try {
    await startHwexecTask({ command: 'true', task_id: 'flow-mem-1' }, WS, USER);
    const remembered = (await handleHwexecPoll({ task_id: 'flow-mem-1', workspace_id: WS })) as {
      verdict: string;
      firstStartedAt?: string;
    };
    assert.equal(remembered.verdict, 'lost');
    assert.ok(remembered.firstStartedAt, 'the receipt is enriched with the remembered startedAt');
    const stranger = (await handleHwexecPoll({ task_id: 'flow-mem-2', workspace_id: WS })) as {
      verdict: string;
      firstStartedAt?: string;
    };
    assert.equal(stranger.verdict, 'unknown');
    assert.equal(stranger.firstStartedAt, undefined);
  } finally {
    seam.restore();
  }
});

test('hwexec poll: the wait budget folds into the exec timeout and the script loop count', async () => {
  const seam = claimingSeam(() => pollStdout({}));
  try {
    await handleHwexecPoll({ task_id: 'flow-budget-1', workspace_id: WS, wait_ms: 60000, tail_bytes: 8192 });
    // wait_ms + 15s headroom inside the exec timeout (A2 doctrine).
    assert.equal(seam.timeouts[0], 75000);
    const script = seam.scripts[0]!;
    assert.match(script, /while \[ "\$i" -lt 30 \]; do/);
    assert.match(script, /tail -c 8192 "\$D\/log"/);
  } finally {
    seam.restore();
  }
});

test('hwexec poll: task_id is required and validated; wait_ms bounds are enforced', async () => {
  await assert.rejects(handleHwexecPoll({ workspace_id: WS }), /invalid task_id/);
  await assert.rejects(handleHwexecPoll({ workspace_id: WS, task_id: 'no-good-id;' }), /invalid task_id/);
  await assert.rejects(
    handleHwexecPoll({ workspace_id: WS, task_id: 'flow-args-1', wait_ms: 60001 }),
    /invalid wait_ms/,
  );
  await assert.rejects(
    handleHwexecPoll({ workspace_id: WS, task_id: 'flow-args-1', tail_bytes: 0 }),
    /invalid tail_bytes/,
  );
});

test('hwexec exec_one_shot: mode "async" routes into the claim protocol; sync stays untouched', async () => {
  const seam = claimingSeam(() => pollStdout({}));
  try {
    const result = (await handleExecOneShot({
      command: 'npm run build',
      mode: 'async',
      task_id: 'flow-route-1',
      workspace_id: WS,
    })) as { started?: boolean | string; taskId: string };
    assert.equal(result.started, true);
    assert.equal(result.taskId, 'flow-route-1');
    assert.match(seam.scripts[0]!, /D=\/tmp\/\.hwexec\/flow-route-1/);
    // An async-mode timeout_ms bounds only the start exec.
    const custom = (await handleExecOneShot({
      command: 'true',
      mode: 'async',
      task_id: 'flow-route-2',
      workspace_id: WS,
      timeout_ms: 45000,
    })) as { started: string | boolean };
    assert.equal(custom.started, true);
    assert.equal(seam.timeouts.at(-1), 45000);
  } finally {
    seam.restore();
  }
});
