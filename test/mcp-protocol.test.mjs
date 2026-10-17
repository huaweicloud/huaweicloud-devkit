import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatch,
  _resetInitializedSessions,
  _isSessionInitialized,
  _resetVersionCheckFlag,
  _wasVersionChecked,
} from '../plugins/huaweicloud-core/src/mcp-protocol.mjs';

const INIT_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '0.0.0' },
};

function resetState() {
  _resetInitializedSessions();
  _resetVersionCheckFlag();
  process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';
}

test('initialize triggers version check via getCachedUpdateInfo (#814 D9-12 ③)', async () => {
  resetState();
  await dispatch('initialize', INIT_PARAMS, { sessionId: 'unit-init' });
  assert.equal(_wasVersionChecked(), true, 'initialize must trigger getCachedUpdateInfo');
  assert.equal(_isSessionInitialized('unit-init'), true, 'session marked initialized after initialize');
});

test('tools/list before initialize returns JSON-RPC -32600 (#814 D9-12 ⑥)', async () => {
  resetState();
  await assert.rejects(
    () => dispatch('tools/list', {}, { sessionId: 'pre-init-list' }),
    (err) => {
      assert.equal(err.code, -32600, 'expected -32600 Invalid Request');
      assert.match(err.message, /not initialized/i);
      return true;
    },
  );
  assert.equal(_isSessionInitialized('pre-init-list'), false, 'session must remain uninitialized');
});

test('tools/call before initialize returns JSON-RPC -32600 (#814 D9-12 ⑥)', async () => {
  resetState();
  await assert.rejects(
    () => dispatch('tools/call', { name: 'huaweicloud_explain_error', arguments: {} }, { sessionId: 'pre-init-call' }),
    (err) => {
      assert.equal(err.code, -32600, 'expected -32600 Invalid Request');
      return true;
    },
  );
});

test('unknown method before initialize returns -32600 not -32601 (#814 D9-12 ⑥)', async () => {
  resetState();
  await assert.rejects(
    () => dispatch('tools/unknown_xyz', {}, { sessionId: 'pre-init-unknown' }),
    (err) => {
      assert.equal(err.code, -32600, 'pre-init unknown method must be -32600, not -32601');
      return true;
    },
  );
});

test('after initialize, tools/list returns tool list (#814 D9-12)', async () => {
  resetState();
  await dispatch('initialize', INIT_PARAMS, { sessionId: 'post-init-list' });
  const result = await dispatch('tools/list', {}, { sessionId: 'post-init-list' });
  assert.ok(Array.isArray(result.tools), 'tools/list must return tools array after initialize');
  assert.ok(result.tools.length > 0, 'tool list must be non-empty');
});

test('after initialize, tools/call routes normally (#814 D9-12)', async () => {
  resetState();
  await dispatch('initialize', INIT_PARAMS, { sessionId: 'post-init-call' });
  const result = await dispatch(
    'tools/call',
    { name: 'huaweicloud_explain_error', arguments: {} },
    { sessionId: 'post-init-call' },
  );
  assert.equal(result.isError, false, 'tools/call must succeed after initialize');
});

test('multi-session isolation: A initialize does not initialize B (#814 D9-12)', async () => {
  resetState();
  await dispatch('initialize', INIT_PARAMS, { sessionId: 'session-A' });
  assert.equal(_isSessionInitialized('session-A'), true, 'A must be initialized');
  assert.equal(_isSessionInitialized('session-B'), false, 'B must remain uninitialized');
  await assert.rejects(
    () => dispatch('tools/list', {}, { sessionId: 'session-B' }),
    (err) => {
      assert.equal(err.code, -32600, 'B tools/list must be rejected with -32600');
      return true;
    },
  );
});

test('initialize is exempt from the pre-init guard (#814)', async () => {
  resetState();
  const result = await dispatch('initialize', INIT_PARAMS, { sessionId: 'fresh' });
  assert.equal(result.serverInfo.name, 'huaweicloud-devkit', 'initialize must succeed without prior init');
  assert.equal(result.protocolVersion, '2024-11-05');
});

test('initialize response shape is unchanged (#814 D9-12 ①)', async () => {
  resetState();
  const result = await dispatch('initialize', INIT_PARAMS, { sessionId: 'shape' });
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.ok(result.capabilities && result.capabilities.tools, 'capabilities.tools must exist');
  assert.equal(result.serverInfo.name, 'huaweicloud-devkit');
  assert.equal(typeof result.serverInfo.version, 'string');
});
