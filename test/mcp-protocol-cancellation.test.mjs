import assert from 'node:assert/strict';
import test from 'node:test';

// mcp-protocol.mjs 导入 callTool from './tools.mjs'。我们通过 Node 的
// module register 暂无便捷 mock 通道，改为对 dispatch 做行为级断言：
// 1) capabilities 含 cancellation
// 2) 预先 abort 的 signal 触发 RequestTimeoutError (code=-32000)
// 3) _meta.timeoutMs 触发超时 (code=-32000) —— 用一个永不 resolve 的 callTool 占位
// 4) abortRequest 中断已注册请求
//
// 对于 3)，我们通过劫持 tools.mjs 的 callTool 导出不可行（ESM 命名导出不可变），
// 因此改用一个确实会「阻塞足够久」的真实路径：dispatch 的 tools/call 会调用
// huaweicloud_hook_check_command（纯本地、无 hcloud 依赖），它几乎立即返回；
// 要触发超时须让工作 Promise 比 timeoutMs 更慢。我们用一个慢速 signal 路径验证：
// 给一个极短 timeoutMs（1ms）并预置一个外部 signal——验证 timeout 与 abort 语义。

import {
  dispatch,
  abortRequest,
  _registerRequest,
  _unregisterRequest,
  _inFlightCount,
  RequestTimeoutError,
  REQUEST_TIMEOUT_ERROR_CODE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createRequestSignal,
  raceWithSignal,
} from '../plugins/huaweicloud-core/src/mcp-protocol.mjs';

test('initialize capabilities declares cancellation (#698 D9-9)', async () => {
  const result = await dispatch('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  assert.ok(Object.hasOwn(result.capabilities, 'cancellation'), 'capabilities must declare cancellation');
  assert.deepEqual(result.capabilities.cancellation, {});
  assert.ok(Object.hasOwn(result.capabilities, 'tools'), 'tools capability retained');
});

test('REQUEST_TIMEOUT_ERROR_CODE is -32000', () => {
  assert.equal(REQUEST_TIMEOUT_ERROR_CODE, -32000);
});

test('RequestTimeoutError carries code -32000 and timeout wording', () => {
  const err = new RequestTimeoutError('Request timed out after 50 ms');
  assert.equal(err.code, -32000);
  assert.match(err.message, /timed out|timeout|cancel/i);
  // 默认消息
  const def = new RequestTimeoutError();
  assert.match(def.message, /timed out/i);
});

test('tools/call with pre-aborted signal throws RequestTimeoutError (-32000)', async () => {
  const controller = new AbortController();
  controller.abort(new RequestTimeoutError('Request cancelled: test'));
  await assert.rejects(
    () =>
      dispatch(
        'tools/call',
        { name: 'huaweicloud_hook_check_command', arguments: { command: 'hcloud ECS NovaListServers' } },
        { signal: controller.signal },
      ),
    (err) => {
      assert.equal(err.code, -32000, 'error code must be -32000');
      assert.match(err.message, /cancel|timeout/i);
      return true;
    },
  );
});

test('tools/call with _meta.timeoutMs + pre-aborted signal throws -32000 (abort precedence)', async () => {
  // 验证 _meta.timeoutMs 被正确解析且不干扰 abort 语义：预先 abort 信号，
  // 即使 _meta.timeoutMs=1000 也应立即走 -32000 分支（abort 优先于超时定时器）。
  const controller = new AbortController();
  controller.abort(new RequestTimeoutError('Request cancelled: test'));
  await assert.rejects(
    () =>
      dispatch(
        'tools/call',
        {
          name: 'huaweicloud_hook_check_command',
          arguments: { command: 'hcloud ECS NovaListServers' },
          _meta: { timeoutMs: 1000 },
        },
        { signal: controller.signal },
      ),
    (err) => {
      assert.equal(err.code, -32000);
      return true;
    },
  );
});

test('abortRequest interrupts a registered in-flight request', () => {
  const controller = new AbortController();
  const reqId = 99999;
  _registerRequest(reqId, controller);
  assert.equal(_inFlightCount() >= 1, true, 'request registered');

  const aborted = abortRequest(reqId, 'Client cancelled');
  assert.equal(aborted, true, 'abortRequest returns true for a live request');
  assert.equal(controller.signal.aborted, true, 'controller signal is aborted');
  assert.equal(controller.signal.reason?.code, -32000, 'abort reason is -32000');

  // 重复 abort 返回 false
  assert.equal(abortRequest(reqId, 'again'), false, 're-abort returns false');
  _unregisterRequest(reqId);
});

test('abortRequest on unknown id returns false', () => {
  assert.equal(abortRequest(88888, 'nope'), false);
});

test('DEFAULT_REQUEST_TIMEOUT_MS defaults to 0 (no protocol-level timeout) unless env set', () => {
  // 环境变量未设置时为 0；测试环境不应设置该变量。
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 0);
});

test('unknown method still returns -32601 (regression guard #650 D9-2)', async () => {
  await assert.rejects(
    () => dispatch('tools/unknown_xyz', {}),
    (err) => {
      assert.equal(err.code, -32601);
      assert.match(err.message, /Method not found/);
      return true;
    },
  );
});

test('raceWithSignal: timeout aborts a pending work with code -32000 (#698 D9-9)', async () => {
  // 用 createRequestSignal 设置 30ms 超时；工作 Promise 永不 resolve（模拟长耗时工具）。
  // 30ms 后 signal 被 abort，raceWithSignal 抛 RequestTimeoutError (code=-32000)。
  const { signal, cleanup } = createRequestSignal({ timeoutMs: 30 }, {});
  const started = Date.now();
  try {
    const neverResolves = new Promise(() => {}); // 永不 resolve
    await assert.rejects(
      () => raceWithSignal(neverResolves, signal),
      (err) => {
        assert.equal(err.code, -32000, 'timed-out work must surface -32000');
        assert.match(err.message, /timeout|timed out/i);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    // 应在 30ms 之后、1s 之前完成（留足调度抖动余量）。
    assert.ok(elapsed >= 25 && elapsed < 1000, `timeout fired around ${elapsed}ms`);
  } finally {
    cleanup();
  }
});

test('raceWithSignal: external abort interrupts pending work with code -32000', async () => {
  const controller = new AbortController();
  const { signal, cleanup } = createRequestSignal({ signal: controller.signal }, {});
  try {
    const neverResolves = new Promise(() => {});
    // 立即 abort 外部 signal。
    setTimeout(() => controller.abort(new RequestTimeoutError('Request cancelled: external')), 5);
    await assert.rejects(
      () => raceWithSignal(neverResolves, signal),
      (err) => {
        assert.equal(err.code, -32000);
        assert.match(err.message, /cancel/i);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('raceWithSignal: completed work returns normally (no false timeout)', async () => {
  const { signal, cleanup } = createRequestSignal({ timeoutMs: 1000 }, {});
  try {
    const fast = Promise.resolve({ ok: true });
    const result = await raceWithSignal(fast, signal);
    assert.equal(result.ok, true);
    assert.equal(signal.aborted, false, 'signal must not abort when work completes first');
  } finally {
    cleanup();
  }
});
