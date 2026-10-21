import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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
  buildDevbridgeVerifyScript,
  parseDevbridgeVerifyOutput,
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  validateTunnelPort,
  validateExpiryHours,
  validateTunnelId,
  DEVBRIDGE_MAX_EXPIRY_HOURS,
  DEVBRIDGE_RENEW_HOURS,
  buildDevbridgeRenewScript,
  parseDevbridgeRenewOutput,
  buildDevbridgeKeepaliveScript,
  buildKeepaliveTunnelsReadScript,
  parseKeepaliveTunnelsOutput,
  mergeKeepaliveTunnels,
  classifyLocalUploadPath,
  buildUploadResetCommand,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

test('919: buildDevbridgeExposeScript starts a session-surviving host on the caller-provided port', () => {
  const script = buildDevbridgeExposeScript(8081);
  // setsid + nohup + stdin detach + disown: without all three the host is reaped
  // when the one-shot exec session ends and the tunnel dies after a green
  // in-session check (#919 "假成功").
  assert.match(script, /setsid nohup devbridge host -p 8081 -e 72/);
  assert.match(script, /< \/dev\/null/);
  assert.match(script, /& fi\ndisown 2>\/dev\/null \|\| true/);
  // #922 (S8): bare-nohup fallback so the host still starts without setsid.
  assert.match(script, /else nohup devbridge host -p 8081 -e 72/);
  assert.match(script, /devbridge delete-all/);
  assert.match(script, /pkill -f "devbridge host"/);
  assert.match(script, /DB_TUNNEL_URL=/);
  assert.match(script, /DB_HTTP_CODE=/);
  // The tunnel lifetime (-e, hours) is echoed so the return value can carry it.
  assert.match(script, /DB_EXPIRY_HOURS=72/);
});

test('922 (S8): buildDevbridgeExposeScript falls back to bare nohup when setsid is missing', () => {
  const script = buildDevbridgeExposeScript(8081);
  // setsid fallback: the host must still start on images without setsid.
  assert.match(script, /if command -v setsid > \/dev\/null 2>&1; then setsid nohup devbridge host -p 8081/);
  assert.match(script, /else nohup devbridge host -p 8081/);
  // disown is guarded: shells without the builtin must not abort the script.
  assert.match(script, /disown 2>\/dev\/null \|\| true/);
});

test('919: buildDevbridgeExposeScript honors a custom expiry and exposes it via parse', () => {
  const script = buildDevbridgeExposeScript(80, 24);
  assert.match(script, /devbridge host -p 80 -e 24/);
  assert.match(script, /DB_EXPIRY_HOURS=24/);
  const parsed = parseDevbridgeExposeOutput(
    'DB_TUNNEL_URL=https://ab12cd34-80.devbridge-s2.hwtunnel.com\nDB_EXPIRY_HOURS=24',
  );
  assert.equal(parsed.expiryHours, 24);
});

test('919: parseDevbridgeExposeOutput extracts expiry hours alongside tunnel fields', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'Tunnel URL: https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_EXPIRY_HOURS=72',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.expiryHours, 72);
  const noExpiry = parseDevbridgeExposeOutput('DB_TUNNEL_URL=\nDB_HTTP_CODE=200');
  assert.equal(noExpiry.expiryHours, undefined);
});

test('919: buildDevbridgeVerifyScript issues a real GET from an independent session', () => {
  const script = buildDevbridgeVerifyScript('https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  assert.match(
    script,
    /curl -s -o \/tmp\/devbridge_verify_body -w "%\{http_code\}" --max-time 10 "https:\/\/c4rdv7bv-8081\.devbridge-s2\.hwtunnel\.com"/,
  );
  assert.match(script, /DB_VERIFY_HTTP_CODE=\$VERIFY_CODE/);
});

test('922 (B1): parseDevbridgeVerifyOutput reads DB_VERIFY_HTTP_CODE (not the DB_HTTP_CODE anchor)', () => {
  const stdout = 'DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=0';
  const parsed = parseDevbridgeVerifyOutput(stdout);
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, false);
  // The anchored ^DB_HTTP_CODE= lookup in parseDevbridgeExposeOutput must NOT
  // be what serves the verify result — it never matches DB_VERIFY_HTTP_CODE=.
  assert.equal(parseDevbridgeExposeOutput(stdout).httpCode, '');
  const failed = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=000\nDB_VERIFY_NOT_FOUND=0');
  assert.equal(failed.httpCode, '000');
  const empty = parseDevbridgeVerifyOutput('');
  assert.equal(empty.httpCode, '');
  assert.equal(empty.notFound, false);
});

test('922 (B2): parseDevbridgeVerifyOutput flags the native false-success "tunnel not found" body', () => {
  const parsed = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=1');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, true);
  // Multiple body matches still count as not-found.
  const multi = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=3');
  assert.equal(multi.notFound, true);
});

test('922 (B2): buildDevbridgeVerifyScript keeps the body and emits the not-found verdict', () => {
  const script = buildDevbridgeVerifyScript('https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  // The body must NOT be discarded with -o /dev/null — the native false-success
  // form answers 200 with a "tunnel not found" body.
  assert.doesNotMatch(script, /-o \/dev\/null/);
  assert.match(script, /grep -ci 'tunnel not found' \/tmp\/devbridge_verify_body/);
  assert.match(script, /DB_VERIFY_NOT_FOUND=\$VERIFY_NOT_FOUND/);
});

test('919: buildDevbridgeVerifyScript rejects URLs unsafe for shell interpolation', () => {
  for (const bad of ['', 'http://x.example.com', 'https://a.example.com/x;rm -rf /', 'https://a"b.com']) {
    assert.throws(
      () => buildDevbridgeVerifyScript(bad),
      /invalid tunnel URL/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('G404: buildDevbridgeExposeScript extracts the tunnel URL anchored to the requested port', () => {
  const script = buildDevbridgeExposeScript(8081);
  // Multi-port hosts print one "Tunnel URL:" line per port; a port-blind
  // `sed | tail -1` can extract the wrong port's URL and hand it over.
  const expectedPattern = 'https://[A-Za-z0-9_-]+-8081\\.devbridge-s2\\.hwtunnel\\.com';
  assert.ok(
    script.includes(`grep -oE "${expectedPattern}"`),
    'must extract the URL with a port-anchored grep, not a port-blind tail',
  );
  assert.doesNotMatch(script, /tail -1/, 'port-blind tail -1 extraction must be gone');
});

test('G404: buildDevbridgeExposeScript captures the probe body for gateway-error detection', () => {
  const script = buildDevbridgeExposeScript(8081);
  assert.match(script, /-o \/tmp\/\.db_probe_body/);
  assert.match(script, /DB_TUNNEL_BODY=/);
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

test('919: DEVBRIDGE_HOST_EXPIRY_HOURS pins the tunnel lifetime used by the expose script', () => {
  assert.equal(DEVBRIDGE_HOST_EXPIRY_HOURS, 72);
  const script = buildDevbridgeExposeScript(80);
  assert.ok(script.includes(`-e ${DEVBRIDGE_HOST_EXPIRY_HOURS}`));
});

test('919: validateTunnelPort accepts integer ports in range', () => {
  assert.equal(validateTunnelPort(8080), 8080);
  assert.equal(validateTunnelPort('8081'), 8081);
  assert.equal(validateTunnelPort(1), 1);
  assert.equal(validateTunnelPort(65535), 65535);
});

test('919: validateTunnelPort rejects strings, decimals, and out-of-range ports (shell-injection guard)', () => {
  for (const bad of ['80;rm -rf /', 'abc', '', null, undefined, 0, -1, 65536, 1.5, '8080;true']) {
    assert.throws(() => validateTunnelPort(bad), /invalid port/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

// --- 953: upload local-path classification + remote mkdir ---

test('953: buildUploadResetCommand mkdirs the remote parent before any chunk writes', () => {
  const cmd = buildUploadResetCommand('/workspace/game2048/index.html', '/workspace/game2048/index.html.b64tmp');
  assert.match(cmd, /^mkdir -p "\$\(dirname "\/workspace\/game2048\/index\.html"\)" && /);
  assert.match(cmd, /rm -f "\/workspace\/game2048\/index\.html\.b64tmp"$/);
});

test('953: buildUploadResetCommand quotes paths containing spaces', () => {
  const cmd = buildUploadResetCommand('/workspace/my site/index .html', '/tmp/x y.b64tmp');
  assert.ok(cmd.includes('"/workspace/my site/index .html"'));
  assert.ok(cmd.includes('"/tmp/x y.b64tmp"'));
});

test('953: classifyLocalUploadPath distinguishes missing file vs missing parent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upload-classify-'));
  const existingFile = join(dir, 'exists.txt');
  writeFileSync(existingFile, 'x');

  // Existing file with existing parent -> pass.
  assert.equal(classifyLocalUploadPath(existingFile, 'file'), null);
  // Existing directory as file -> type mismatch keeps the old semantics.
  assert.match(classifyLocalUploadPath(dir, 'file').message, /path is not a regular file/);

  // Missing file, existing parent -> accurate "not found".
  const missingFile = join(dir, 'missing.txt');
  assert.match(classifyLocalUploadPath(missingFile, 'file').message, /local regular file not found/);

  // Missing file AND missing parent -> names the parent + tmp hint (the #953 report case).
  const deepMissing = join(dir, 'no', 'such', 'dir', 'file.txt');
  const err = classifyLocalUploadPath(deepMissing, 'file');
  assert.match(err.message, /directory not found/);
  assert.match(err.message, new RegExp(escapeRegExp(dir + sep + 'no')));
  assert.match(err.message, /temp directory/);

  // Directory kind mirrors the three states for upload_project.
  assert.equal(classifyLocalUploadPath(dir, 'directory'), null);
  assert.match(classifyLocalUploadPath(join(dir, 'no', 'dir'), 'directory').message, /directory not found/);
  assert.match(classifyLocalUploadPath(existingFile, 'directory').message, /path is not a directory/);
});

test('953: classifyLocalUploadPath hint names the real OS temp dir', () => {
  const err = classifyLocalUploadPath(join(tmpdir(), 'definitely-not-here-953', 'f.txt'), 'file');
  assert.ok(err.message.includes(tmpdir()), 'hint should include the actual tmpdir path');
});

// --- G404: gateway-level tunnel errors (verified against the live s2 gateway) ---
// The s2 gateway answers, with exact text/plain bodies:
//   404 "tunnel not found"      — no live host session (host process dead / tunnel deleted)
//   404 "port not configured"   — URL port not registered on the tunnel
//   502 "bad gateway"           — host alive, registered port has no local service
// These must be treated as unreachable/broken, NOT as "content issue" PASSes.

test('G404: parseDevbridgeExposeOutput detects gateway tunnel errors from the probe body', () => {
  const sample = (code, body) =>
    [
      'DB_HOST_LOG=',
      'DB_TUNNEL_URL=https://abc12345-8081.devbridge-s2.hwtunnel.com',
      `DB_HTTP_CODE=${code}`,
      `DB_TUNNEL_BODY=${body}`,
      'DB_QUOTA_ERROR=0',
    ].join('\n');

  const dead = parseDevbridgeExposeOutput(sample('404', 'tunnel not found'));
  assert.equal(dead.gatewayTunnelError, true, '404 "tunnel not found" must be a gateway tunnel error');

  const unregistered = parseDevbridgeExposeOutput(sample('404', 'port not configured'));
  assert.equal(unregistered.gatewayTunnelError, true, '404 "port not configured" must be a gateway tunnel error');

  const backendDown = parseDevbridgeExposeOutput(sample('502', 'bad gateway'));
  assert.equal(backendDown.badGateway, true);
  assert.equal(backendDown.gatewayTunnelError, false, '502 is a backend issue, not a dead tunnel');

  // An app's own 404 page must NOT be misjudged as a gateway tunnel error.
  const app404 = parseDevbridgeExposeOutput(sample('404', '<!DOCTYPE html><html><body>Not Found</body>'));
  assert.equal(app404.gatewayTunnelError, false, 'app-generated 404 body must not be flagged');
  assert.equal(app404.badGateway, false);

  const ok = parseDevbridgeExposeOutput(sample('200', 'E1-CONTROL-OK'));
  assert.equal(ok.gatewayTunnelError, false);
  assert.equal(ok.badGateway, false);
});

test('G404: buildDeployCheckScript probe fails on gateway tunnel-error markers', () => {
  const script = buildDeployCheckScript({
    port: 8080,
    project: 'myapp',
    outputPath: '/workspace/myapp/dist',
    isCrossPlatform: false,
  });
  // Status-gated exact-body checks (grep -x): no false positives on app HTML
  assert.match(script, /\[ "\$code" = "404" \] && grep -qx "tunnel not found"/);
  assert.match(script, /\[ "\$code" = "404" \] && grep -qx "port not configured"/);
  assert.match(script, /\[ "\$code" = "502" \] && grep -qx "bad gateway"/);
  // Migration placeholder check retained
  assert.match(script, /服务已迁移/);
});

test('G404: buildDeployCheckScript probes listed tunnels and selects one that actually serves the port', () => {
  const script = buildDeployCheckScript({
    port: 8080,
    project: 'myapp',
    outputPath: '/workspace/myapp/dist',
    isCrossPlatform: false,
  });
  // Candidate loop (bounded) instead of blindly taking the first `devbridge list` row —
  // list order is arbitrary and a stale tunnel listed first must not shadow the live one.
  assert.match(script, /for CAND in \$TUNNEL_IDS/);
  assert.match(script, /CAND_URL="https:\/\/\$\{CAND\}-8080\./);
  assert.match(script, /head -5/);
  // TUNNEL_URL is only set from a candidate that passed the probe
  assert.match(script, /TUNNEL_URL="\$SELECTED_URL"/);
});

test('G404: parseDeployCheckOutput routes a gateway tunnel-error FAIL to expose_via_devbridge', () => {
  const stdout = [
    '=== DEPLOY CHECK ===',
    'nginx_serving:PASS (port 8080, HTTP 200)',
    'output_dir:PASS (/workspace/myapp/dist)',
    'devbridge_tunnel:PASS',
    'tunnel_url_accessible:FAIL (https://abc12345-8080.devbridge-s2.hwtunnel.com -> tunnel not found (no live host session on the gateway))',
    'SCORE:3/4',
    'VERDICT:INCOMPLETE',
  ].join('\n');
  const result = parseDeployCheckOutput(stdout, { port: 8080, isCrossPlatform: false });
  assert.equal(result.checks.tunnel_url_accessible.status, 'FAIL');
  assert.equal(result.nextStep, 'expose_via_devbridge');
  assert.equal(result.publicUrl, undefined, 'no publicUrl may be fabricated for a dead tunnel');
});

// --- #946: OSC 133 / CSI escape prefixes and \r\n line endings blind the anchored
// ^DB_... parsers on shells with shell-integration enabled (real capture from the
// hd-space-ai-shell2 image: every output line is wrapped in \x1b]133;C\x07).
// parseDeployCheckOutput already strips them; expose/verify/auth parsers must too.
const OSC = '\x1b]133;C\x07';
const oscLine = (s) => OSC + s;

test('#946: parseDevbridgeExposeOutput extracts all fields from OSC-wrapped, CRLF output', () => {
  const stdout = [
    oscLine('DB_HOST_LOG='),
    oscLine('Created tunnel: abc12345'),
    oscLine('Tunnel URL: https://abc12345-8081.devbridge-s2.hwtunnel.com'),
    oscLine('DB_TUNNEL_URL=https://abc12345-8081.devbridge-s2.hwtunnel.com'),
    oscLine('DB_HTTP_CODE=200'),
    oscLine('DB_TUNNEL_BODY=E1-CONTROL-OK'),
    oscLine('DB_EXPIRY_HOURS=72'),
    oscLine('DB_QUOTA_ERROR=0'),
  ].join('\r\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.tunnelUrl, 'https://abc12345-8081.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.tunnelId, 'abc12345');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.gatewayTunnelError, false);
  assert.equal(parsed.expiryHours, 72);

  const dead = parseDevbridgeExposeOutput(
    [
      oscLine('DB_TUNNEL_URL=https://abc12345-8081.devbridge-s2.hwtunnel.com'),
      oscLine('DB_HTTP_CODE=404'),
      oscLine('DB_TUNNEL_BODY=tunnel not found'),
      oscLine('DB_QUOTA_ERROR=0'),
    ].join('\r\n'),
  );
  assert.equal(dead.gatewayTunnelError, true, '404 "tunnel not found" behind OSC escapes must still be detected');
});

test('#946: parseDevbridgeVerifyOutput extracts code and not-found behind OSC escapes', () => {
  const stdout = [oscLine('DB_VERIFY_HTTP_CODE=200'), oscLine('DB_VERIFY_NOT_FOUND=0')].join('\r\n');
  const parsed = parseDevbridgeVerifyOutput(stdout);
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, false);

  const notFound = parseDevbridgeVerifyOutput(
    [oscLine('DB_VERIFY_HTTP_CODE=404'), oscLine('DB_VERIFY_NOT_FOUND=1')].join('\r\n'),
  );
  assert.equal(notFound.httpCode, '404');
  assert.equal(notFound.notFound, true);
});

test('#946: parseDevbridgeAuthOutput keeps per-tier attempts behind OSC escapes', () => {
  const stdout = [
    oscLine('DB_ATTEMPT_KEYRING=no-valid-key'),
    oscLine('DB_ATTEMPT_AKSK=binary-or-creds-unavailable'),
    oscLine('DB_AUTH_MODE=API_KEY_FILE'),
  ].join('\r\n');
  const parsed = parseDevbridgeAuthOutput(stdout);
  assert.equal(parsed.authMode, 'API_KEY_FILE');
  assert.equal(parsed.attempts.KEYRING, 'no-valid-key');
  assert.equal(parsed.attempts.AKSK, 'binary-or-creds-unavailable');
});

test('#946: stripTerminalEscapes is exported for reuse by all DB_* parsers', async () => {
  const mod = await import('../plugins/huaweicloud-core/src/sandbox/session-manager.mjs');
  assert.equal(typeof mod.stripTerminalEscapes, 'function');
  const cleaned = mod.stripTerminalEscapes(oscLine('DB_HTTP_CODE=200') + '\r\n');
  assert.equal(cleaned, 'DB_HTTP_CODE=200\n');
});

// --- Tunnel persistence: expiry validation, renewal, keepalive watchdog (2026-10 measured) ---

test('tunnel-persistence: validateExpiryHours accepts 1..720 and rejects everything else', () => {
  assert.equal(validateExpiryHours(1), 1);
  assert.equal(validateExpiryHours(72), 72);
  assert.equal(validateExpiryHours(DEVBRIDGE_MAX_EXPIRY_HOURS), 720);
  for (const bad of [0, -1, 721, 10000, 1.5, 'abc', NaN]) {
    assert.throws(() => validateExpiryHours(bad), /invalid expiry_hours/, `expected rejection for ${bad}`);
  }
});

test('tunnel-persistence: validateTunnelId accepts devbridge base36 IDs and rejects shell metacharacters', () => {
  assert.equal(validateTunnelId('nv2dvv6w'), 'nv2dvv6w');
  assert.equal(validateTunnelId('kag7rozs'), 'kag7rozs');
  for (const bad of ['', 'ab', 'rm -rf /tmp', 'id;reboot', '$(id)', 'a'.repeat(33)]) {
    assert.throws(() => validateTunnelId(bad), /invalid tunnel_id/, `expected rejection for ${bad}`);
  }
});

test('tunnel-persistence: buildDevbridgeRenewScript splices a validated ID + expiry and surfaces expiration', () => {
  // 720h = the devbridge 30-day maximum (measured 2026-10) — the default horizon.
  assert.equal(DEVBRIDGE_RENEW_HOURS, 720);
  const script = buildDevbridgeRenewScript('kag7rozs', 720);
  assert.match(script, /devbridge update kag7rozs -e 720/);
  // Absolute expiration is surfaced via show -v (tunnelExpiration, Unix seconds) —
  // a bare exit code cannot distinguish "renewed" from "mgmt lost the record (10002)".
  assert.match(script, /devbridge show kag7rozs -v/);
  assert.match(script, /tunnelExpiration/);
  assert.match(script, /DB_RENEW_EXIT=/);
  assert.throws(() => buildDevbridgeRenewScript('bad id; reboot'), /invalid tunnel_id/);
  assert.throws(() => buildDevbridgeRenewScript('kag7rozs', 721), /invalid expiry_hours/);
  // The auto-enroll read script greps the INSTALLED watchdog's TUNNELS line —
  // the single source of truth for currently-protected tunnels.
  assert.match(buildKeepaliveTunnelsReadScript(), /grep -m1 '\^TUNNELS=' \/tmp\/tunnel-keepalive\.sh/);
});

test('tunnel-persistence: parseDevbridgeRenewOutput requires exit 0 AND an absolute expiration', () => {
  const ok = parseDevbridgeRenewOutput(
    'DB_RENEW_EXIT=0\nDB_RENEW_ID=kag7rozs\nDB_RENEW_HOURS=720\nDB_EXPIRATION=1795022391\nDB_RENEW_ERROR=',
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.tunnelId, 'kag7rozs');
  assert.equal(ok.renewedForHours, 720);
  assert.equal(ok.expiresAt, new Date(1795022391 * 1000).toISOString());
  // 10002 "tunnel not found" — mgmt record lost while the data plane still serves:
  const lost = parseDevbridgeRenewOutput(
    'DB_RENEW_EXIT=1\nDB_RENEW_ID=nv2dvv6w\nDB_RENEW_HOURS=720\nDB_EXPIRATION=\nDB_RENEW_ERROR=Failed to update tunnel: error code: 10002, error message: tunnel not found',
  );
  assert.equal(lost.ok, false);
  assert.match(lost.error, /10002/);
  assert.equal(lost.expiresAt, undefined);
});

test('tunnel-persistence: buildDevbridgeKeepaliveScript installs the 3-layer watchdog with hardcoded URLs', () => {
  const tunnels = [
    { tunnelId: 'kag7rozs', url: 'https://kag7rozs-3000.devbridge-s2.hwtunnel.com' },
    { tunnelId: 'qtka62w2', url: 'https://qtka62w2-8080.devbridge-s2.hwtunnel.com' },
  ];
  const script = buildDevbridgeKeepaliveScript(tunnels);
  // Heredoc is single-quoted: the writer shell expands nothing.
  assert.match(script, /cat > \/tmp\/tunnel-keepalive\.sh << 'DB_KEEPALIVE_EOF'/);
  assert.match(script, /DB_KEEPALIVE_EOF/);
  // Layer 1: host watchdog — tunnel-specific pgrep (a bare "devbridge host" pgrep
  // matches ANY tunnel's host and silently skips re-attaching the dead one).
  assert.match(script, /pgrep -f "devbridge host \$ID"/);
  assert.match(script, /setsid nohup devbridge host "\$ID"/);
  // Layer 2: daily renewal at the 720h maximum.
  assert.match(script, /devbridge update "\$ID" -e 720/);
  assert.match(script, /-ge 86400/);
  // Layer 3: health check with hardcoded URLs (port list output is OSC-wrapped
  // and breaks anchored greps — URLs are never derived from it).
  assert.match(
    script,
    /TUNNELS="kag7rozs:https:\/\/kag7rozs-3000\.devbridge-s2\.hwtunnel\.com qtka62w2:https:\/\/qtka62w2-8080\.devbridge-s2\.hwtunnel\.com"/,
  );
  assert.match(script, /DB_KEEPALIVE_SYNTAX=/);
  // Replacement kills the old loop first so two loops never double-renew.
  assert.match(script, /pkill -f "tunnel-keepalive\.sh"/);
});

test('tunnel-persistence: buildDevbridgeKeepaliveScript validates input', () => {
  assert.throws(() => buildDevbridgeKeepaliveScript([]), /non-empty array/);
  assert.throws(
    () => buildDevbridgeKeepaliveScript([{ tunnelId: 'bad id', url: 'https://x.devbridge-s2.hwtunnel.com' }]),
    /invalid tunnel_id/,
  );
  assert.throws(
    () => buildDevbridgeKeepaliveScript([{ tunnelId: 'kag7rozs', url: 'http://insecure.example.com' }]),
    /invalid tunnel URL/,
  );
});

test('tunnel-persistence: parseKeepaliveTunnelsOutput reads the installed watchdog tunnel list', () => {
  const parsed = parseKeepaliveTunnelsOutput(
    'DB_KEEPALIVE_TUNNELS=kag7rozs:https://kag7rozs-3000.devbridge-s2.hwtunnel.com qtka62w2:https://qtka62w2-8080.devbridge-s2.hwtunnel.com',
  );
  assert.deepEqual(parsed, [
    { tunnelId: 'kag7rozs', url: 'https://kag7rozs-3000.devbridge-s2.hwtunnel.com' },
    { tunnelId: 'qtka62w2', url: 'https://qtka62w2-8080.devbridge-s2.hwtunnel.com' },
  ]);
  // No watchdog installed yet → empty list.
  assert.deepEqual(parseKeepaliveTunnelsOutput('DB_KEEPALIVE_TUNNELS='), []);
  assert.deepEqual(parseKeepaliveTunnelsOutput(''), []);
});

test('tunnel-persistence: mergeKeepaliveTunnels dedupes by ID, incoming wins, order preserved', () => {
  const existing = [
    { tunnelId: 'kag7rozs', url: 'https://kag7rozs-3000.devbridge-s2.hwtunnel.com' },
    { tunnelId: 'aabbccdd', url: 'https://aabbccdd-80.devbridge-s2.hwtunnel.com' },
  ];
  // Re-exposing kag7rozs refreshes its URL; a new tunnel is appended; aabbccdd survives.
  const merged = mergeKeepaliveTunnels(existing, [{ tunnelId: 'kag7rozs', url: 'https://new.example.com' }]);
  assert.deepEqual(merged, [
    { tunnelId: 'kag7rozs', url: 'https://new.example.com' },
    { tunnelId: 'aabbccdd', url: 'https://aabbccdd-80.devbridge-s2.hwtunnel.com' },
  ]);
  assert.equal(
    mergeKeepaliveTunnels([], [{ tunnelId: 'x1y2z3w4', url: 'https://x1y2z3w4-3000.devbridge-s2.hwtunnel.com' }])
      .length,
    1,
  );
  assert.deepEqual(mergeKeepaliveTunnels(null, []), []);
});
