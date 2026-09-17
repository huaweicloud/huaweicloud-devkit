import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WS_EXEC_INDEX_URL,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  parseDiagChainOutput,
  getCurrentWorkspaceId,
  setWorkspaceId,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';

test('ws-exec dynamic import uses file:// URL (Windows-safe)', async () => {
  assert.ok(WS_EXEC_INDEX_URL.startsWith('file://'), `expected file:// URL, got: ${WS_EXEC_INDEX_URL}`);
  const mod = await import(WS_EXEC_INDEX_URL);
  assert.equal(typeof mod.connectHwlinkTerminalSession, 'function');
  assert.equal(typeof mod.executeHwlinkCommand, 'function');
});

test('splitBase64Chunks splits into chunks no larger than the limit and reassembles losslessly', () => {
  const base64 = Buffer.from('x'.repeat(100000)).toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= UPLOAD_CHUNK_SIZE, `chunk exceeds limit: ${chunk.length}`);
  }
  assert.equal(chunks.join(''), base64);
});

test('splitBase64Chunks returns a single chunk for small inputs', () => {
  const base64 = Buffer.from('hello').toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], base64);
});

test('currentWorkspaceId defaults to null without env or setter', () => {
  assert.equal(getCurrentWorkspaceId(), null);
});

test('setWorkspaceId caches and updates env var', () => {
  const testId = 'test-workspace-123';
  setWorkspaceId(testId);
  assert.equal(getCurrentWorkspaceId(), testId);
  assert.equal(process.env.HW_WORKSPACE_ID, testId);
  setWorkspaceId(null);
});

test('parseDiagChainOutput extracts status, code and latency per hop (with ANSI noise)', () => {
  const stdout =
    '\x1b[0m=== DIAG CHAIN ===\r\n' +
    'diag:tunnel:PASS status=200 latency=0.125\r\n' +
    'diag:proxy:FAIL status=502 latency=0.003\r\n' +
    'diag:pm2:PASS\r\n' +
    '\x1b[1;32mVERDICT:COMPLETE\x1b[0m';
  const result = parseDiagChainOutput(stdout, ['tunnel', 'proxy', 'pm2']);
  assert.equal(result.complete, false);
  assert.equal(result.firstFailure, 'proxy');
  assert.deepEqual(result.failedHops, ['proxy']);
  assert.deepEqual(result.missingHops, []);
  assert.equal(result.hops.length, 3);
  assert.equal(result.hops[0].statusCode, 200);
  assert.equal(result.hops[0].latencyMs, 125);
  assert.equal(result.hops[1].statusCode, 502);
  assert.equal(result.hops[1].latencyMs, 3);
  assert.equal(result.hops[2].status, 'PASS');
});

test('parseDiagChainOutput flags a hop whose result line is missing entirely', () => {
  const stdout = 'diag:tunnel:PASS status=200 latency=0.010\ndiag:proxy:FAIL status=000 latency=0.000';
  const result = parseDiagChainOutput(stdout, ['tunnel', 'proxy', 'pm2']);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingHops, ['pm2']);
  assert.deepEqual(result.failedHops, ['proxy']);
  assert.equal(result.firstFailure, 'proxy');
});

test('parseDiagChainOutput returns parseWarning when no hop lines are found', () => {
  const result = parseDiagChainOutput('some unrelated output', ['tunnel']);
  assert.equal(result.complete, false);
  assert.equal(result.hops.length, 0);
  assert.match(result.parseWarning, /No hop results/);
  assert.ok(result.rawOutput);
});
