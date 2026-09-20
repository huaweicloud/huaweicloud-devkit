import assert from 'node:assert/strict';
import test from 'node:test';

// Never trigger a real background KooCLI preinstall or auto-upgrade: importing
// mcp-protocol.mjs pulls the hdkitservice/auto-upgrade import chain.
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';

const protocol = await import('../plugins/huaweicloud-core/src/mcp-protocol.mjs');
const {
  _consumeRequestCancellation,
  _isSessionInitialized,
  _markInitialized,
  _markRequestCancelled,
  _resetCancelledRequests,
  _resetInitializedSessions,
} = protocol;

test.afterEach(() => {
  _resetInitializedSessions();
  _resetCancelledRequests();
});

test('initialize state is tracked per session and reset clears it (#774 D9-4)', () => {
  _resetInitializedSessions();

  assert.equal(_isSessionInitialized('session-a'), false, 'a fresh session must start uninitialized');
  _markInitialized('session-a');
  assert.equal(_isSessionInitialized('session-a'), true);
  assert.equal(_isSessionInitialized('session-b'), false, 'sessions are isolated from each other');

  _resetInitializedSessions();
  assert.equal(_isSessionInitialized('session-a'), false, 'reset must clear every tracked session');
});

test('tracked sessions stay bounded and evict the oldest entry (#774 D9-4)', () => {
  _resetInitializedSessions();
  const total = 2000;

  for (let i = 0; i < total; i++) _markInitialized(`bounded-session-${i}`);

  assert.equal(_isSessionInitialized(`bounded-session-${total - 1}`), true, 'the newest session stays tracked');
  assert.equal(_isSessionInitialized('bounded-session-0'), false, 'the oldest session must be evicted');

  // Re-initializing a session refreshes its recency, so it survives the next
  // eviction pass even though newer sessions keep arriving.
  _markInitialized('bounded-session-1980');
  for (let i = 0; i < 100; i++) _markInitialized(`churn-session-${i}`);
  assert.equal(_isSessionInitialized('bounded-session-1980'), true, 're-initialized session is refreshed, not evicted');
});

test('cancelled request ids are consumed exactly once (#774 D9-9)', () => {
  _resetCancelledRequests();

  assert.equal(_consumeRequestCancellation('stdin', 42), false, 'unknown request id is not cancelled');

  _markRequestCancelled('stdin', 42);
  assert.equal(_consumeRequestCancellation('stdin', 42), true, 'the registered request is cancelled');
  assert.equal(_consumeRequestCancellation('stdin', 42), false, 'the cancellation record is consumed once');

  // Cancellations are scoped per session.
  _markRequestCancelled('session-a', 7);
  assert.equal(_consumeRequestCancellation('session-b', 7), false);
  assert.equal(_consumeRequestCancellation('session-a', 7), true);

  // A notification without a requestId is ignored rather than tracking "undefined".
  _markRequestCancelled('stdin', undefined);
  _markRequestCancelled('stdin', null);
  assert.equal(_consumeRequestCancellation('stdin', undefined), false);
  assert.equal(_consumeRequestCancellation('stdin', null), false);
});

test('cancellation tracking stays bounded (#774 D9-9)', () => {
  _resetCancelledRequests();

  for (let i = 0; i < 2000; i++) _markRequestCancelled('stdin', i);

  assert.equal(_consumeRequestCancellation('stdin', 1999), true, 'the newest cancellation is tracked');
  assert.equal(_consumeRequestCancellation('stdin', 0), false, 'the oldest cancellation is evicted');
});
