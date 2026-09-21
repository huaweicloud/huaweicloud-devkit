import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WS_EXEC_INDEX_URL,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  getCurrentWorkspaceId,
  setWorkspaceId,
  isValidPublicUrl,
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

// --- Issue #787: deploy_check publicUrl validation ---

test('isValidPublicUrl accepts a well-formed https URL', () => {
  assert.equal(isValidPublicUrl('https://abc123-8080.cn-north-4-bridge.myhuaweicloud.com'), true);
});

test('isValidPublicUrl accepts a well-formed http URL', () => {
  assert.equal(isValidPublicUrl('http://example.com:8080'), true);
});

test('isValidPublicUrl rejects URL with empty tunnel ID (host starts with -)', () => {
  // This is the exact invalid URL from Issue #787: https://-8080.cn-north-4...
  assert.equal(isValidPublicUrl('https://-8080.cn-north-4-bridge.myhuaweicloud.com'), false);
});

test('isValidPublicUrl rejects undefined input', () => {
  assert.equal(isValidPublicUrl(undefined), false);
});

test('isValidPublicUrl rejects empty string', () => {
  assert.equal(isValidPublicUrl(''), false);
});

test('isValidPublicUrl rejects non-URL strings', () => {
  assert.equal(isValidPublicUrl('not-a-url'), false);
});

test('isValidPublicUrl rejects URLs with non-http protocols', () => {
  assert.equal(isValidPublicUrl('ftp://example.com'), false);
  assert.equal(isValidPublicUrl('file:///etc/passwd'), false);
});

test('isValidPublicUrl rejects host containing double dashes (invalid hostname)', () => {
  assert.equal(isValidPublicUrl('https://tunnel--8080.example.com'), false);
});
