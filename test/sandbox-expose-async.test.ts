import assert from 'node:assert/strict';
import test from 'node:test';

import { _setOneShotForTests } from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import { handleExposePoll, handleExposeTunnel } from '../plugins/huaweicloud-core/src/packs/sandbox/handlers-tunnel.ts';
import {
  EXPOSE_TASK_ID_PATTERN,
  _resetExposeTasksForTests,
} from '../plugins/huaweicloud-core/src/packs/sandbox/expose-task.ts';
import { AUTH_FAIL_STDOUT, healthyOneShot } from './devbridge-harness.ts';

// AX N-SB.1: the expose chain can outlive the host's per-request timeout
// while the server completes it. The async mode returns a taskId at once and
// the poll tool delivers the publicUrl in-band.
const URL_8080 = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';

async function waitForDone(taskId: string) {
  for (let i = 0; i < 500; i += 1) {
    const poll = await handleExposePoll({ task_id: taskId });
    if (poll.state !== 'running') return poll;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await handleExposePoll({ task_id: taskId });
}

test('async expose starts immediately and poll delivers the publicUrl (N-SB.1)', async () => {
  _resetExposeTasksForTests();
  _setOneShotForTests(healthyOneShot(URL_8080));
  try {
    const start = (await handleExposeTunnel({
      mode: 'async',
      port: 8080,
      workspace_id: 'ws-1',
      keepalive: false,
    })) as { started: boolean; mode: string; taskId: string; hint: string };
    assert.equal(start.started, true);
    assert.equal(start.mode, 'async');
    assert.match(start.taskId, EXPOSE_TASK_ID_PATTERN, 'the task id is the exp-<uuid> shape the schema accepts');
    assert.match(start.hint, /huaweicloud_sandbox_expose_poll/);

    const poll = await waitForDone(start.taskId);
    assert.equal(poll.state, 'done');
    assert.equal(poll.state === 'done' && poll.result.ok, true);
    assert.equal(poll.state === 'done' && poll.result.publicUrl, URL_8080);
    assert.equal(poll.state === 'done' && poll.result.port, 8080);
  } finally {
    _setOneShotForTests(null);
    _resetExposeTasksForTests();
  }
});

test('async expose surfaces a resolved ok:false envelope through the poll (N-SB.1)', async () => {
  _resetExposeTasksForTests();
  _setOneShotForTests(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) return { stdout: AUTH_FAIL_STDOUT, exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  });
  try {
    const start = (await handleExposeTunnel({
      mode: 'async',
      port: 8081,
      workspace_id: 'ws-1',
      keepalive: false,
    })) as { taskId: string };
    const poll = await waitForDone(start.taskId);
    assert.equal(poll.state, 'done');
    assert.equal(poll.state === 'done' && poll.result.ok, false);
    assert.equal(poll.state === 'done' && poll.result.error_code, undefined);
  } finally {
    _setOneShotForTests(null);
    _resetExposeTasksForTests();
  }
});

test('async expose validates the port synchronously — no task for an illegal port (N-SB.1)', async () => {
  _resetExposeTasksForTests();
  _setOneShotForTests(healthyOneShot(URL_8080));
  try {
    await assert.rejects(
      handleExposeTunnel({ mode: 'async', port: '80;rm -rf /' as unknown as number, workspace_id: 'ws-1' }),
      /invalid port/,
    );
  } finally {
    _setOneShotForTests(null);
    _resetExposeTasksForTests();
  }
});

test('the poll reports unknown for a receipt this process never held (N-SB.1)', async () => {
  _resetExposeTasksForTests();
  const poll = await handleExposePoll({ task_id: 'exp-00000000-0000-0000-0000-000000000000' });
  assert.equal(poll.state, 'unknown');
  assert.match(poll.state === 'unknown' ? poll.hint : '', /deploy_check|re-run huaweicloud_sandbox_expose_tunnel/);
});

test('the sync default keeps the existing contract (N-SB.1)', async () => {
  _resetExposeTasksForTests();
  _setOneShotForTests(healthyOneShot(URL_8080));
  try {
    const result = (await handleExposeTunnel({
      port: 8080,
      workspace_id: 'ws-1',
      keepalive: false,
    })) as { ok: boolean; publicUrl?: string; started?: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.publicUrl, URL_8080);
    assert.equal(result.started, undefined);
  } finally {
    _setOneShotForTests(null);
    _resetExposeTasksForTests();
  }
});
