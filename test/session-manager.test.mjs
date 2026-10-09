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
  resolveProxyNodePort,
  buildExposeRemediation,
  TUNNEL_URL_PATTERN,
  buildDeployCheckScript,
  parseDeployCheckOutput,
  buildDevbridgeAuthProbe,
  parseDevbridgeAuthOutput,
  buildDevbridgeExposeScript,
  parseDevbridgeExposeOutput,
  validateTunnelPort,
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
  assert.match(msg, /source \/tmp\/hw_api_key/);
  assert.match(msg, /devbridge port create <tunnelId> -p 82 --protocol http -a/);
  assert.match(msg, /use THAT port instead/);
});

test('TUNNEL_URL_PATTERN matches a real tunnel URL', () => {
  const m = 'TUNNEL_URL:https://c4rdv7bv-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN);
  assert.ok(m, 'valid URL should match');
  assert.equal(m[1], 'https://c4rdv7bv-80.devbridge-s2.hwtunnel.com');
});

test('TUNNEL_URL_PATTERN rejects URL with empty tunnel prefix', () => {
  assert.equal('TUNNEL_URL:https://-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN), null);
});

test('TUNNEL_URL_PATTERN no longer matches the migrated legacy domain', () => {
  assert.equal('TUNNEL_URL:https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN), null);
});

test('resolveProxyNodePort defaults to nginxListenPort + 1 when no nodePort is given', async () => {
  const port = await resolveProxyNodePort(undefined, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort keeps the explicit nodePort when it differs from the nginx listen port', async () => {
  const port = await resolveProxyNodePort(82, 80, async () => false);
  assert.equal(port, 82);
});

test('resolveProxyNodePort falls back to nginxListenPort + 1 when nodePort collides with the nginx listen port', async () => {
  const port = await resolveProxyNodePort(80, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort re-probes upward when the default candidate is in use', async () => {
  const used = new Set([81]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 82);
});

test('resolveProxyNodePort re-probes upward when the explicit nodePort is in use', async () => {
  const used = new Set([82]);
  const port = await resolveProxyNodePort(82, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

test('resolveProxyNodePort re-probes past targetPort + 1 when it is occupied', async () => {
  const used = new Set([81, 82]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

test('D3-C3: buildDeployCheckScript accepts any non-zero HTTP code for nginx_serving', () => {
  const script = buildDeployCheckScript({
    port: 8080,
    project: 'myapp',
    outputPath: '/workspace/myapp/dist',
    isCrossPlatform: false,
  });
  assert.ok(!script.includes('grep -qE "^(2|3)"'), 'must not use 2xx/3xx-only grep');
  assert.ok(script.includes('HTTP_CODE'), 'must capture HTTP_CODE variable');
  assert.ok(script.includes('"000"'), 'must check for 000 (connection refused)');
  assert.ok(script.includes('nginx_serving:PASS'), 'must emit PASS line');
});

test('D3-C3: parseDeployCheckOutput returns nginx_serving PASS when nginx responds', () => {
  const stdout = [
    '=== DEPLOY CHECK ===',
    'nginx_serving:PASS (port 8080, HTTP 404)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:PASS (https://abc-8080.cn-north-4-bridge.myhuaweicloud.com -> 200)',
    'qr_code:SKIP (not a cross-platform project)',
    'SCORE:4/4',
    'TUNNEL_URL:https://abc-8080.cn-north-4-bridge.myhuaweicloud.com',
    'VERDICT:COMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.checks.nginx_serving.status, 'PASS');
  assert.equal(result.complete, true);
  assert.equal(result.score.pass, 4);
  assert.equal(result.score.total, 4);
});

test('D3-C3: parseDeployCheckOutput returns nginx_serving FAIL when no response', () => {
  const stdout = [
    '=== DEPLOY CHECK ===',
    'nginx_serving:FAIL (port 8080, no HTTP response)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:FAIL',
    'tunnel_url_accessible:FAIL (no tunnel URL)',
    'qr_code:SKIP (not a cross-platform project)',
    'SCORE:1/3',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.checks.nginx_serving.status, 'FAIL');
  assert.equal(result.complete, false);
  assert.ok(result.missingSteps.includes('nginx_serving'));
});

test('D: buildDevbridgeAuthProbe implements the verified waterfall (keyring → AK/SK → file)', () => {
  const script = buildDevbridgeAuthProbe();
  // Tier 1: keyring API Key — stderr capture (2>&1), devbridge_ prefix filter, env self-heal
  assert.match(script, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1/);
  assert.match(script, /"devbridge_"\*\)/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_KEYRING/);
  assert.match(script, /DBUS_SESSION_BUS_ADDRESS.*unix:path=\/run\/dbus-session/);
  assert.match(script, /HOME.*:-\/root/);
  // Tier 1 light revive: bus restart + unlocked keyring daemon, no package installs
  assert.match(script, /dbus-daemon --session/);
  assert.match(script, /gnome-keyring-daemon --unlock/);
  assert.ok(!script.includes('dnf install'), 'waterfall must not install packages at runtime');
  // Tier 2: AK/SK — STS token is mandatory (401 APIGW.0301 without it), 0.1.x --huaweicloud is conditional
  assert.match(script, /devbridge auth login --help.*--access-key/s);
  assert.match(script, /--access-key "\$HW_ACCESS_KEY" --secret-key "\$HW_SECRET_KEY"/);
  assert.match(script, /DB_TOKEN_ARGS="--security-token \\"\$HW_SECURITY_TOKEN\\""|DB_TOKEN_ARGS=.*--security-token/);
  assert.match(script, /grep -q -- '--huaweicloud'/);
  assert.match(script, /DB_AUTH_MODE=AKSK_SUPPORTED/);
  // Tier 3: user-provided file fallback
  assert.match(script, /source \/tmp\/hw_creds\.sh/);
  assert.match(script, /source \/tmp\/hw_api_key/);
  assert.match(script, /--api-key "\$HW_API_KEY"/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_FILE/);
  // All tiers verified via real login + auth status; diagnostics emitted; final failure mode
  assert.match(script, /db_login_ok\(\) \{ devbridge auth status.*Logged in/);
  assert.match(script, /DB_ATTEMPT_/);
  assert.match(script, /DB_AUTH_MODE=NO_CREDENTIAL/);
  // Secrets are not left in the environment after the probe
  assert.match(script, /unset HW_DB_KEY HW_API_KEY DB_TOKEN_ARGS/);
});

test('D: parseDevbridgeAuthOutput extracts the final auth mode and per-tier attempt diagnostics', () => {
  const stdout = [
    'DB_ATTEMPT_KEYRING=no-valid-key',
    'DB_ATTEMPT_AKSK=binary-or-creds-unavailable',
    'DB_ATTEMPT_APIKEY_FILE=no-file',
    'DB_AUTH_MODE=NO_CREDENTIAL',
  ].join('\n');
  const parsed = parseDevbridgeAuthOutput(stdout);
  assert.equal(parsed.authMode, 'NO_CREDENTIAL');
  assert.equal(parsed.attempts.KEYRING, 'no-valid-key');
  assert.equal(parsed.attempts.AKSK, 'binary-or-creds-unavailable');
  assert.equal(parsed.attempts.APIKEY_FILE, 'no-file');

  const success = parseDevbridgeAuthOutput('DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=AKSK_SUPPORTED\n');
  assert.equal(success.authMode, 'AKSK_SUPPORTED');
  assert.equal(success.attempts.KEYRING, 'no-valid-key');
  assert.deepEqual(success.attempts.AKSK, undefined);

  const empty = parseDevbridgeAuthOutput('');
  assert.equal(empty.authMode, '');
  assert.deepEqual(empty.attempts, {});
});

test('D: buildDevbridgeExposeScript binds the host to the caller-provided port', () => {
  const script = buildDevbridgeExposeScript(8081);
  assert.match(script, /devbridge host -p 8081 -e 8/);
  assert.match(script, /devbridge delete-all/);
  assert.match(script, /pkill -f "devbridge host"/);
  assert.match(script, /sed -n 's\/\.\*Tunnel URL: \*\/\/p' \/tmp\/host\.log/);
  assert.match(script, /DB_TUNNEL_URL=/);
  assert.match(script, /DB_HTTP_CODE=/);
});

test('D: parseDevbridgeExposeOutput extracts tunnel URL, id, HTTP code, and quota flag', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'some log line',
    'Tunnel URL: https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.tunnelUrl, 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.tunnelId, 'c4rdv7bv');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.quotaError, false);
});

test('D: parseDevbridgeExposeOutput flags quota error 10006', () => {
  const stdout = ['DB_TUNNEL_URL=', 'DB_HTTP_CODE=000', 'DB_QUOTA_ERROR=1', 'tail: 10006 quota exceeded'].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.quotaError, true);
  assert.equal(parsed.tunnelUrl, '');
});

test('D: parseDevbridgeExposeOutput tolerates empty host log (no tunnel yet)', () => {
  const parsed = parseDevbridgeExposeOutput('DB_HOST_LOG=\nDB_TUNNEL_URL=\nDB_HTTP_CODE=\nDB_QUOTA_ERROR=0');
  assert.equal(parsed.tunnelUrl, '');
  assert.equal(parsed.httpCode, '');
  assert.equal(parsed.tunnelId, '');
});

test('P1: validateTunnelPort accepts integer ports in range', () => {
  assert.equal(validateTunnelPort(8080), 8080);
  assert.equal(validateTunnelPort('8081'), 8081);
  assert.equal(validateTunnelPort(1), 1);
  assert.equal(validateTunnelPort(65535), 65535);
});

test('P1: validateTunnelPort rejects strings, decimals, and out-of-range ports (shell-injection guard)', () => {
  for (const bad of ['80;rm -rf /', 'abc', '', null, undefined, 0, -1, 65536, 1.5, '8080;true']) {
    assert.throws(() => validateTunnelPort(bad), /invalid port/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});
