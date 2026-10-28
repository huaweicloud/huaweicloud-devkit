import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizePersistMode,
  getCurrentPersistMode,
  resetPersistModeStateForTest,
  buildWatchdogStopScript,
  closeSession,
  getCurrentWorkspaceId,
  setWorkspaceId,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';
import { hdkitReleaseSession } from '../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..', 'plugins', 'huaweicloud-core');

// --- #1046 acceptance 4: persist_mode defaults to ephemeral (backward compat) ---

test('#1046: normalizePersistMode defaults missing/invalid values to ephemeral', () => {
  assert.equal(normalizePersistMode(undefined), 'ephemeral');
  assert.equal(normalizePersistMode(null), 'ephemeral');
  assert.equal(normalizePersistMode(''), 'ephemeral');
  assert.equal(normalizePersistMode('EPHEMERAL'), 'ephemeral');
  assert.equal(normalizePersistMode('persistent'), 'persistent');
  assert.equal(normalizePersistMode('Persistent'), 'persistent');
  // Unknown values MUST fall back to ephemeral, never throw — an agent passing
  // a typo'd mode must not lose the sandbox session over it.
  assert.equal(normalizePersistMode('forever'), 'ephemeral');
  assert.equal(normalizePersistMode(42), 'ephemeral');
  assert.equal(normalizePersistMode({ mode: 'persistent' }), 'ephemeral');
});

// --- #1046: connection records persist_mode in session metadata ---

test('#1046: setWorkspaceId records persistMode alongside the workspace id', () => {
  resetPersistModeStateForTest();
  try {
    const testId = `test-ws-${Date.now()}`;
    setWorkspaceId(testId, 'persistent');
    assert.equal(getCurrentWorkspaceId(), testId);
    assert.equal(getCurrentPersistMode(), 'persistent');

    // Missing mode → ephemeral (acceptance 4: callers that never learned about
    // persist_mode keep the exact pre-#1046 behavior).
    setWorkspaceId(`${testId}-b`);
    assert.equal(getCurrentPersistMode(), 'ephemeral');

    setWorkspaceId(null);
    assert.equal(getCurrentWorkspaceId(), null);
  } finally {
    resetPersistModeStateForTest();
  }
});

// --- #1046: hdkitReleaseSession is a mark-only wrapper (no invented endpoint) ---

test('#1046: hdkitReleaseSession returns a mark-only result without inventing a server endpoint', async () => {
  const result = await hdkitReleaseSession('dev-stage-abc', { persistMode: 'ephemeral' });
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.mode, 'mark-only');
  assert.equal(result.devStageId, 'dev-stage-abc');
  assert.equal(result.persistMode, 'ephemeral');
  assert.match(result.note, /mark/i);
  // The wrapper must be idempotent-friendly: calling it again returns the same
  // shape (idempotence is enforced by the caller's releasedWorkspaces guard,
  // but the wrapper itself must never throw on repeat calls).
  const again = await hdkitReleaseSession('dev-stage-abc', { persistMode: 'ephemeral' });
  assert.equal(again.released, true);
  // Missing devStageId is rejected instead of silently "releasing" nothing.
  await assert.rejects(() => hdkitReleaseSession(''), /dev_stage_id/);
  await assert.rejects(() => hdkitReleaseSession(undefined), /dev_stage_id/);
});

// --- #1046: the watchdog stop script kills ONLY the tunnel keepalive loop ---

test('#1046: buildWatchdogStopScript kills the keepalive loop without touching sandbox services', () => {
  const script = buildWatchdogStopScript();
  // Scoped to the keepalive script name — a bare pkill would kill unrelated processes.
  assert.match(script, /pkill -f "tunnel-keepalive\.sh"/);
  // Best effort: failures (no watchdog installed) must not fail the close.
  assert.match(script, /\|\| true/);
});

// --- #1046 acceptance 1+2: closeSession branches on persist_mode ---

test('#1046: closeSession recycles an ephemeral workspace exactly once (idempotent)', async () => {
  resetPersistModeStateForTest();
  const key = `ephemeral-ws-${Date.now()}`;
  const closes = [];
  const releases = [];
  // A minimal fake terminal session: close() is tracked, never throws.
  const fakeSession = { close: () => closes.push(key) };
  const { __setSessionForTest } = await import('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs');
  __setSessionForTest(
    key,
    'root',
    fakeSession,
    { persistMode: 'ephemeral' },
    {
      release: async (devStageId, opts) => {
        releases.push({ devStageId, opts });
        return { ok: true, released: true, mode: 'mark-only', devStageId, persistMode: opts.persistMode };
      },
      execOneShot: async () => ({ stdout: 'DB_WATCHDOG_STOPPED=0', exitCode: 0 }),
    },
  );

  const first = await closeSession(key, 'root');
  assert.equal(first.closed, true);
  assert.equal(first.persistMode, 'ephemeral');
  assert.equal(first.recycled, true);
  assert.equal(first.recycleExecuted, true, 'first close must trigger the recycle flow');
  assert.equal(first.watchdogStopped, true);
  assert.equal(releases.length, 1, 'exactly one release call on first close');
  assert.equal(releases[0].devStageId, key);
  assert.equal(releases[0].opts.persistMode, 'ephemeral');
  assert.deepEqual(closes, [key]);

  // Second close on the same key: session is gone, nothing left to recycle.
  // recycled:true + recycleSkipped means "already in released state" — the
  // recycle ACTION was not re-executed (releases.length stays 1).
  const second = await closeSession(key, 'root');
  assert.equal(second.closed, false);
  assert.equal(second.recycled, true, 'workspace stays in the released state');
  assert.equal(second.recycleSkipped, 'already_released');
  assert.equal(second.recycleExecuted, false, 'repeat close must NOT re-trigger recycling');
  assert.equal(releases.length, 1, 'idempotence: no second release call');
});

test('#1046: closeSession on a persistent workspace only closes the terminal', async () => {
  resetPersistModeStateForTest();
  const key = `persistent-ws-${Date.now()}`;
  const closes = [];
  const releases = [];
  const fakeSession = { close: () => closes.push(key) };
  const { __setSessionForTest } = await import('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs');
  __setSessionForTest(
    key,
    'root',
    fakeSession,
    { persistMode: 'persistent' },
    {
      release: async (devStageId, opts) => {
        releases.push({ devStageId, opts });
        return { ok: true, released: true, mode: 'mark-only', devStageId, persistMode: opts.persistMode };
      },
      execOneShot: async () => ({ stdout: 'DB_WATCHDOG_STOPPED=0', exitCode: 0 }),
    },
  );

  const result = await closeSession(key, 'root');
  assert.equal(result.closed, true);
  assert.equal(result.persistMode, 'persistent');
  assert.equal(result.recycled, false, 'persistent close must NOT recycle the data disk');
  assert.equal(result.recycleExecuted, false);
  assert.equal(result.watchdogStopped, false, 'persistent close keeps the keepalive watchdog');
  assert.equal(releases.length, 0, 'no release call for persistent sessions');
  assert.deepEqual(closes, [key], 'terminal session WAS closed');
});

test('#1046: missing persist_mode on closeSession falls back to ephemeral (backward compat)', async () => {
  resetPersistModeStateForTest();
  const key = `legacy-ws-${Date.now()}`;
  const releases = [];
  const { __setSessionForTest } = await import('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs');
  __setSessionForTest(
    key,
    'root',
    { close: () => {} },
    {},
    {
      release: async (devStageId, opts) => {
        releases.push({ devStageId, opts });
        return { ok: true, released: true, mode: 'mark-only', devStageId, persistMode: opts.persistMode };
      },
      execOneShot: async () => ({ stdout: 'DB_WATCHDOG_STOPPED=0', exitCode: 0 }),
    },
  );

  const result = await closeSession(key, 'root');
  assert.equal(result.persistMode, 'ephemeral');
  assert.equal(result.recycleExecuted, true, 'legacy callers (no persist_mode) get the ephemeral branch');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].opts.persistMode, 'ephemeral');
});

// --- #1046: disconnect path shares the same branching ---

test('#1046: closeSession handles a closing terminal session (session already dead) without throwing', async () => {
  resetPersistModeStateForTest();
  const key = `dead-session-ws-${Date.now()}`;
  const releases = [];
  const { __setSessionForTest } = await import('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs');
  // close() throws like a half-dead WebSocket would.
  __setSessionForTest(
    key,
    'root',
    {
      close: () => {
        throw new Error('already closed');
      },
    },
    { persistMode: 'ephemeral' },
    {
      release: async (devStageId, opts) => {
        releases.push({ devStageId, opts });
        return { ok: true, released: true, mode: 'mark-only', devStageId, persistMode: opts.persistMode };
      },
      execOneShot: async () => ({ stdout: 'DB_WATCHDOG_STOPPED=0', exitCode: 0 }),
    },
  );

  const result = await closeSession(key, 'root');
  assert.equal(result.closed, true);
  assert.equal(result.recycled, true, 'a dead terminal session still enters the recycle flow');
  assert.equal(releases.length, 1);
});

// --- #1046 acceptance 3: watchdog auto-enrol gates on persistent mode ---

test('#1046: exposeTunnel auto-enrol guard requires persistent mode (structure guard)', () => {
  const sessionManager = readFileSync(join(pluginRoot, 'src', 'sandbox', 'session-manager.mjs'), 'utf8');
  // The AUTO-ENROLL block must consult the session's persist mode — a bare
  // keepalive !== false check would enrol ephemeral tunnels.
  const enrollBlock = sessionManager.match(/AUTO-ENROLL[\s\S]{0,1600}?installKeepaliveWatchdog/);
  assert.ok(enrollBlock, 'AUTO-ENROLL block not found');
  assert.match(enrollBlock[0], /[sS]essionPersistMode === 'persistent'/, 'auto-enrol must be gated on persistent mode');
  // Ephemeral sessions get an explicit opt-out record instead of silence.
  assert.match(sessionManager, /reason: 'ephemeral_session'/);
});

test('#1046: huaweicloud_sandbox_connect schema exposes persist_mode with ephemeral default', () => {
  const tools = readFileSync(join(pluginRoot, 'src', 'tools.mjs'), 'utf8');
  const connectSchema = tools.match(
    /name: 'huaweicloud_sandbox_connect',[\s\S]*?inputSchema: \{[\s\S]*?\n {2}\},\n {2}\{/,
  );
  assert.ok(connectSchema, 'huaweicloud_sandbox_connect schema not found');
  assert.match(connectSchema[0], /persist_mode/);
  assert.match(connectSchema[0], /ephemeral/);
  assert.match(connectSchema[0], /persistent/);
  // The connect handler must pass persist_mode into the session metadata.
  assert.match(tools, /setWorkspaceId\(devStageId, /);
  // hdkitConnect must forward persist_mode in the request body when present.
  const hdkitservice = readFileSync(join(pluginRoot, 'src', 'sandbox', 'hdkitservice-api.mjs'), 'utf8');
  assert.match(hdkitservice, /options\.persist_mode/);
});

test('#1046: huaweicloud_sandbox_close_session returns the branching outcome', () => {
  const tools = readFileSync(join(pluginRoot, 'src', 'tools.mjs'), 'utf8');
  const closeBlock = tools.match(/case 'huaweicloud_sandbox_close_session': \{[\s\S]*?\n {4}\}/);
  assert.ok(closeBlock, 'huaweicloud_sandbox_close_session handler not found');
  assert.match(closeBlock[0], /persistMode/);
  assert.match(closeBlock[0], /recycled/);
  assert.match(closeBlock[0], /watchdogStopped/);
  // Backward compat: a close with no live session still reports not_connected.
  assert.match(closeBlock[0], /not_connected/);
});

// --- #1046: releasedWorkspaces guard in the source (idempotence structure guard) ---

test('#1046: session-manager carries the releasedWorkspaces idempotence guard', () => {
  const sessionManager = readFileSync(join(pluginRoot, 'src', 'sandbox', 'session-manager.mjs'), 'utf8');
  assert.match(sessionManager, /releasedWorkspaces/);
  // The guard must be consulted before recycling.
  assert.match(sessionManager, /releasedWorkspaces\.has\(/);
  assert.match(sessionManager, /releasedWorkspaces\.add\(/);
});
