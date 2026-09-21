import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WS_EXEC_INDEX_URL,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  getCurrentWorkspaceId,
  setWorkspaceId,
  isValidPublicUrl,
  buildDeployCheckDegradation,
  deployCheck,
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

// --- Issue #787: deployCheck retryAttempts and degradation fixes ---

// Helper: build a stdout string that deployCheck's script parser can consume.
function makeCheckOutput(opts = {}) {
  const {
    nginx = 'PASS',
    outputDir = 'PASS',
    contentVerified = 'PASS',
    devbridge = 'PASS',
    tunnelAccessible = 'PASS',
    tunnelUrl,
    verdict = 'COMPLETE',
    qrCode,
  } = opts;
  const lines = ['=== DEPLOY CHECK ==='];
  lines.push(`nginx_serving:${nginx}`);
  lines.push(`output_dir:${outputDir}`);
  if (contentVerified === 'SKIP') {
    lines.push('content_verified:SKIP (no fingerprint file)');
  } else {
    lines.push(`content_verified:${contentVerified}`);
  }
  lines.push(`devbridge_tunnel:${devbridge}`);
  if (tunnelAccessible === 'PASS') {
    lines.push(`tunnel_url_accessible:PASS (https://tunnel-8080.example.com -> 200)`);
  } else if (tunnelUrl) {
    lines.push(`tunnel_url_accessible:FAIL (https://${tunnelUrl} -> HTTP 000)`);
  } else {
    lines.push('tunnel_url_accessible:FAIL (no DevBridge tunnel established — run devbridge create first)');
  }
  if (qrCode) lines.push(`qr_code:${qrCode}`);
  const pass = [
    nginx,
    outputDir,
    contentVerified === 'SKIP' ? null : contentVerified,
    devbridge,
    tunnelAccessible,
    qrCode,
  ].filter((s) => s === 'PASS').length;
  const total = [nginx, outputDir, contentVerified, devbridge, tunnelAccessible, qrCode].filter(
    (s) => s !== 'SKIP' && s !== undefined,
  ).length;
  lines.push(`SCORE:${pass}/${total}`);
  if (tunnelUrl) lines.push(`TUNNEL_URL:https://${tunnelUrl}`);
  lines.push(`VERDICT:${verdict}`);
  return lines.join('\n');
}

// No-op delay so retry tests don't wait 5s per iteration.
const noDelay = () => Promise.resolve();

test('deployCheck retryAttempts = 1 when first attempt succeeds (no retry)', async () => {
  let callCount = 0;
  const mockExec = async () => {
    callCount++;
    return { stdout: makeCheckOutput({ verdict: 'COMPLETE' }), exitCode: 0 };
  };
  const result = await deployCheck(
    'ws-test',
    { port: 8080, project: 'demo', outputDir: 'dist', frameworkType: 'web' },
    'root',
    5000,
    mockExec,
    noDelay,
  );
  assert.equal(callCount, 1, 'execOneShot should be called exactly once');
  assert.equal(result.retryAttempts, 1, 'retryAttempts should be 1, not the max(3)');
  assert.equal(result.complete, true);
});

test('deployCheck retryAttempts reflects actual retries when nginx fails then succeeds', async () => {
  const outputs = [
    makeCheckOutput({ nginx: 'FAIL', tunnelAccessible: 'PASS', verdict: 'INCOMPLETE' }),
    makeCheckOutput({ nginx: 'FAIL', tunnelAccessible: 'PASS', verdict: 'INCOMPLETE' }),
    makeCheckOutput({ verdict: 'COMPLETE' }),
  ];
  let callCount = 0;
  const mockExec = async () => ({ stdout: outputs[callCount++], exitCode: 0 });
  const result = await deployCheck(
    'ws-test',
    { port: 8080, project: 'demo', outputDir: 'dist', frameworkType: 'web' },
    'root',
    5000,
    mockExec,
    noDelay,
  );
  assert.equal(callCount, 3, 'execOneShot should be called 3 times');
  assert.equal(result.retryAttempts, 3, 'retryAttempts should be 3 after 3 attempts');
  assert.equal(result.complete, true);
});

test('deployCheck does not retry tunnel_url_accessible when devbridge_tunnel FAILs', async () => {
  let callCount = 0;
  const mockExec = async () => {
    callCount++;
    return {
      stdout: makeCheckOutput({
        nginx: 'PASS',
        devbridge: 'FAIL',
        tunnelAccessible: 'FAIL',
        verdict: 'INCOMPLETE',
      }),
      exitCode: 0,
    };
  };
  const result = await deployCheck(
    'ws-test',
    { port: 8080, project: 'demo', outputDir: 'dist', frameworkType: 'web' },
    'root',
    5000,
    mockExec,
    noDelay,
  );
  assert.equal(callCount, 1, 'should NOT retry when devbridge_tunnel FAILs');
  assert.equal(result.retryAttempts, 1);
  assert.equal(result.complete, false);
  assert.ok(result.missingSteps.includes('devbridge_tunnel'), 'missingSteps should include devbridge_tunnel');
});

test('deployCheck retries tunnel_url_accessible when devbridge_tunnel PASSES but URL not yet accessible', async () => {
  const outputs = [
    makeCheckOutput({
      devbridge: 'PASS',
      tunnelAccessible: 'FAIL',
      tunnelUrl: 'tunnel-id-8080.example.com',
      verdict: 'INCOMPLETE',
    }),
    makeCheckOutput({
      devbridge: 'PASS',
      tunnelAccessible: 'FAIL',
      tunnelUrl: 'tunnel-id-8080.example.com',
      verdict: 'INCOMPLETE',
    }),
    makeCheckOutput({
      devbridge: 'PASS',
      tunnelAccessible: 'FAIL',
      tunnelUrl: 'tunnel-id-8080.example.com',
      verdict: 'INCOMPLETE',
    }),
  ];
  let callCount = 0;
  const mockExec = async () => ({ stdout: outputs[callCount++], exitCode: 0 });
  const result = await deployCheck(
    'ws-test',
    { port: 8080, project: 'demo', outputDir: 'dist', frameworkType: 'web' },
    'root',
    5000,
    mockExec,
    noDelay,
  );
  assert.equal(callCount, 3, 'should retry up to max when devbridge PASS but tunnel_url FAIL');
  assert.equal(result.retryAttempts, 3);
  assert.equal(result.complete, false);
});

test('buildDeployCheckDegradation does not accept checks parameter (dead param removed)', () => {
  // After the fix, buildDeployCheckDegradation takes (missing, publicUrl) — no checks param.
  const warning = buildDeployCheckDegradation(['nginx_serving'], undefined);
  assert.ok(typeof warning === 'string');
  assert.ok(warning.includes('nginx'));
});

test('buildDeployCheckDegradation includes tunnel_url_accessible message with publicUrl', () => {
  const url = 'https://tunnel-8080.example.com';
  const warning = buildDeployCheckDegradation(['tunnel_url_accessible'], url);
  assert.ok(warning.includes(url), 'warning should mention the publicUrl');
});

test('buildDeployCheckDegradation includes fallback message when missing is empty', () => {
  const warning = buildDeployCheckDegradation([], undefined);
  assert.ok(warning.includes('Deploy check incomplete'));
});
