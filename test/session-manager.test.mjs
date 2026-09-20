import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WS_EXEC_INDEX_URL,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  getCurrentWorkspaceId,
  setWorkspaceId,
  formatPortConflictWarning,
  formatPortDriftWarning,
  formatProxyPortWarning,
  buildExposeRemediation,
  TUNNEL_URL_PATTERN,
  parseDeployCheckOutput,
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

test('formatPortConflictWarning returns undefined when port is unchanged', () => {
  assert.equal(formatPortConflictWarning(80, 80), undefined);
});

test('formatPortConflictWarning reports the real auto-assigned port', () => {
  assert.equal(formatPortConflictWarning(80, 81), 'Port 80 is in use — auto-assigned port 81');
});

test('formatPortDriftWarning is undefined without drift', () => {
  assert.equal(formatPortDriftWarning(80, 80), undefined);
});

test('formatPortDriftWarning names both ports and the re-bind command', () => {
  const msg = formatPortDriftWarning(80, 81);
  assert.match(msg, /nginx now listens on port 81/);
  assert.match(msg, /devbridge port create <tunnelId> -p 81 --protocol http -a/);
});

test('buildExposeRemediation includes credential sourcing and host command with port', () => {
  const msg = buildExposeRemediation(82);
  assert.match(msg, /source \/tmp\/hw_creds\.sh/);
  assert.match(msg, /devbridge port create <tunnelId> -p 82 --protocol http -a/);
  assert.match(msg, /use THAT port instead/);
});

test('TUNNEL_URL_PATTERN matches a real tunnel URL', () => {
  const m = 'TUNNEL_URL:https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN);
  assert.ok(m, 'valid URL should match');
  assert.equal(m[1], 'https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com');
});

test('TUNNEL_URL_PATTERN rejects URL with empty tunnel prefix', () => {
  assert.equal('TUNNEL_URL:https://-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN), null);
});

test('formatProxyPortWarning is undefined without drift', () => {
  assert.equal(formatProxyPortWarning(80, 80), undefined);
});

test('formatProxyPortWarning explains proxy templates ignore auto-increment', () => {
  const msg = formatProxyPortWarning(80, 81);
  assert.match(msg, /still listens on port 80/);
  assert.match(msg, /auto-increment does not apply to proxy configs/);
});

test('parseDeployCheckOutput detects auto-incremented port and sets portWarning (#762 defect 6)', () => {
  const simulatedStdout = [
    '=== DEPLOY CHECK ===',
    'nginx_serving:PASS (port 8081, auto-detected — requested port 8080 was auto-incremented)',
    'ACTUAL_PORT:8081',
    'output_dir:PASS (/workspace/myapp/dist)',
    'content_verified:PASS',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:PASS (https://tunnel-8081.example.com -> 200)',
    'qr_code:SKIP (not a cross-platform project)',
    'SCORE:5/5',
    'TUNNEL_URL:https://tunnel-8081.example.com',
    'VERDICT:COMPLETE',
  ].join('\n');

  const result = parseDeployCheckOutput(simulatedStdout, 8080, false);
  assert.equal(result.complete, true);
  assert.equal(result.detectedPort, '8081');
  assert.ok(result.portWarning, 'portWarning should be set when port shifts');
  assert.match(result.portWarning, /8080.*8081/);
  assert.equal(result.checks.nginx_serving.status, 'PASS');
});

test('parseDeployCheckOutput leaves detectedPort undefined when port matches (#762 defect 6)', () => {
  const simulatedStdout = [
    '=== DEPLOY CHECK ===',
    'nginx_serving:PASS (port 8080)',
    'ACTUAL_PORT:8080',
    'output_dir:PASS (/workspace/myapp/dist)',
    'content_verified:PASS',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:PASS (https://tunnel-8080.example.com -> 200)',
    'SCORE:5/5',
    'TUNNEL_URL:https://tunnel-8080.example.com',
    'VERDICT:COMPLETE',
  ].join('\n');

  const result = parseDeployCheckOutput(simulatedStdout, 8080, false);
  assert.equal(result.complete, true);
  assert.equal(result.detectedPort, undefined);
  assert.equal(result.portWarning, undefined);
});

test('parseDeployCheckOutput uses detectedPort for remediation when port shifts (#762 defect 6)', () => {
  const simulatedStdout = [
    'nginx_serving:PASS (port 8081, auto-detected)',
    'ACTUAL_PORT:8081',
    'output_dir:PASS (/workspace/app/dist)',
    'content_verified:PASS',
    'devbridge_tunnel:FAIL',
    'tunnel_url_accessible:FAIL (no tunnel URL)',
    'SCORE:3/5',
    'VERDICT:INCOMPLETE',
  ].join('\n');

  const result = parseDeployCheckOutput(simulatedStdout, 8080, false);
  assert.equal(result.complete, false);
  assert.equal(result.nextStep, 'expose_via_devbridge');
  assert.equal(result.detectedPort, '8081');
  assert.ok(result.remediation, 'remediation should be set for expose_via_devbridge');
  assert.match(result.remediation, /8081/);
  assert.doesNotMatch(result.remediation, /-p 8080\b/);
});
