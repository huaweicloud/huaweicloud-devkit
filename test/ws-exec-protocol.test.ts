import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  FIXED_HEADER_LEN,
  MAX_SEND_CHUNK_SIZE,
  OpCode,
  createPacket,
  parsePacket,
} from '../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import { buildMarkers, buildShellCommands } from '../plugins/huaweicloud-core/src/ws-exec/ws-exec-client.ts';
import {
  doneMarkerFor,
  extractDoneNonce,
  extractReadyNonce,
  readyMarkerFor,
  runShellCommand,
  DEPLOY_CHECK_ALL_PASS,
  DEVBRIDGE_AUTH_KEYRING_STDOUT,
  DEVBRIDGE_EXPOSE_OK_STDOUT,
  DEVBRIDGE_VERIFY_OK_STDOUT,
  FakeFs,
} from './e2e/ws-fake/fake-shell.ts';
import {
  buildUploadResetCommand,
  parseDeployCheckOutput,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.ts';
import {
  buildDevbridgeAuthProbe,
  buildDevbridgeExposeScript,
  buildDevbridgeVerifyScript,
  parseDevbridgeAuthOutput,
  parseDevbridgeExposeOutput,
  parseDevbridgeVerifyOutput,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import {
  buildDevbridgeKeepaliveScript,
  buildKeepaliveTunnelsReadScript,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-keepalive.ts';

// Golden pins for the hwlink wire protocol the E2E ws-fake shares with the
// product. The fake imports the product's codec, so a codec regression
// makes fake and product regress TOGETHER — these literal byte vectors are
// the independent oracle that catches the drift (vendored upstream hwlink
// format: 20-byte big-endian header, one packet per ws message).

test('createPacket golden bytes: terminal open (0xfb, username payload)', () => {
  const frame = createPacket({
    operation: OpCode.OpNewCmdTerminal,
    identifier: 5,
    source: 12345,
    payload: new TextEncoder().encode('root'),
  });
  assert.equal(
    Buffer.from(frame).toString('hex'),
    '05000018000000fb000000000000000500003039' + '726f6f74',
    'terminal-open frame must match the upstream hwlink layout byte-for-byte',
  );
});

test('createPacket golden bytes: terminal data (0xfd, small payload)', () => {
  const frame = createPacket({
    operation: OpCode.OpCmdTerminalData,
    identifier: 5,
    source: 12345,
    payload: new TextEncoder().encode('hi'),
  });
  assert.equal(Buffer.from(frame).toString('hex'), '05000016000000fd000000000000000500003039' + '6869');
});

test('parsePacket round-trips the golden terminal-open bytes', () => {
  const bytes = Buffer.from('05000018000000fb000000000000000500003039' + '726f6f74', 'hex');
  const packet = parsePacket(bytes);
  assert.equal(packet.operation, 0xfb);
  assert.equal(packet.identifier, 5);
  assert.equal(packet.source, 12345);
  assert.equal(Buffer.from(packet.data ?? []).toString('utf8'), 'root');
  assert.equal(packet.packetLength, bytes.length);
});

test('chunk math both sides rely on: MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN === 8172', () => {
  assert.equal(MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN, 8172);
  assert.equal(FIXED_HEADER_LEN, 20);
});

// Cross-tier marker pins: the fake's recognizers must recover exactly what
// the product's buildShellCommands emits — drift on EITHER side reds here.

test('fake recognizers recover the product-built ready/done nonces', () => {
  const markers = buildMarkers('aabbccddeeff0011');
  const { readyCommand, doneCommand } = buildShellCommands(markers);
  assert.equal(extractReadyNonce(readyCommand), 'aabbccddeeff0011');
  assert.equal(extractDoneNonce(doneCommand), 'aabbccddeeff0011');
  // The emitted markers must be the exact strings the product's
  // tryCompletePending scans for (ready echo / done + ':<rc>').
  assert.ok(readyMarkerFor('aabbccddeeff0011').includes('__WS_EXEC_READY_aabbccddeeff0011__'));
  assert.ok(doneMarkerFor('aabbccddeeff0011', 0).includes('__WS_EXEC_DONE_aabbccddeeff0011__:0'));
});

test('buildShellCommands output shape is pinned (printf framing)', () => {
  const { readyCommand, doneCommand } = buildShellCommands(buildMarkers('deadbeefdeadbeef'));
  assert.match(readyCommand, /stty -echo 2>\/dev\/null/);
  assert.match(readyCommand, /__WS_EXEC_READY_' 'deadbeefdeadbeef__'/);
  assert.match(doneCommand, /^__ws_exec_rc=\$\?; printf /);
  assert.match(doneCommand, /__WS_EXEC_DONE_' 'deadbeefdeadbeef__:/);
});

test('fake shell intent table: echo answers its text, probes answer empty, unknown is distinct', () => {
  const echo = runShellCommandWithFs('echo hello-from-e2e\n');
  assert.equal(echo.intent, 'echo');
  assert.equal(echo.stdout, 'hello-from-e2e\n');
  assert.equal(echo.exitCode, 0);

  assert.equal(runShellCommandWithFs('devbridge delete-all 2>/dev/null || true\n').intent, 'devbridge-delete-all');
  assert.equal(
    runShellCommandWithFs('export PATH=/workspace/.local/bin:$HOME/.huawei/bin${PATH:+:$PATH}\n').intent,
    'export-path',
  );
  // Unrecognized commands record distinctly — the zero-unknown gate keys on
  // this so product script drift turns cases red instead of degrading.
  assert.equal(runShellCommandWithFs('some-future-script --flag\n').intent, 'unknown');
});

function runShellCommandWithFs(command: string): ReturnType<typeof runShellCommand> {
  return runShellCommand(command, new FakeFs());
}

test('fake fs round-trip: printf batches → base64 decode → real md5', () => {
  const fs = new FakeFs();
  const content = Buffer.from('Hello from the e2e upload case — line two for body mass.\n'.repeat(40), 'utf8');
  const b64 = content.toString('base64');
  const chunks = [b64.slice(0, 30000), b64.slice(30000)].filter(Boolean);
  // The reset pin feeds the PRODUCT's builder output through the recognizer —
  // a buildUploadResetCommand shape change the fake no longer recognizes
  // turns this red instead of silently degrading the e2e drift guard.
  const resetCmd = buildUploadResetCommand('/tmp/hello.txt', '/tmp/hello.b64tmp');
  assert.equal(
    resetCmd,
    'mkdir -p "$(dirname "/tmp/hello.txt")" && rm -f "/tmp/hello.b64tmp"',
    'the #953 compound reset shape is pinned on the product side',
  );
  const reset = runShellCommand(resetCmd, fs);
  assert.equal(reset.intent, 'rm', 'the fake must recognize the product reset shape');
  for (const chunk of chunks) {
    const append = runShellCommand(`printf '%s' '${chunk}' >> "/tmp/hello.b64tmp"`, fs);
    assert.equal(append.intent, 'printf-append');
    assert.equal(append.exitCode, 0);
  }
  const decode = runShellCommand(`base64 -d "/tmp/hello.b64tmp" > "/tmp/hello.txt" && rm -f "/tmp/hello.b64tmp"`, fs);
  assert.equal(decode.intent, 'base64-decode');
  assert.equal(decode.exitCode, 0);
  const verify = runShellCommand(`md5sum "/tmp/hello.txt"`, fs);
  assert.equal(verify.intent, 'md5sum');
  const expected = createHash('md5').update(content).digest('hex');
  assert.ok(verify.stdout.startsWith(`${expected}  `), `md5 must match the real hash: ${verify.stdout}`);
  // The tmp file is gone after decode.
  assert.equal(runShellCommand(`md5sum "/tmp/hello.b64tmp"`, fs).exitCode, 1);
});

test('createPacket golden bytes: tunnel create (0x03) and success (0x0800)', () => {
  // srcPort 54321 (0xD431), dstPort 8888 (0x22B8), identifier 1, source
  // 778899 (0x000BE293), empty payloads — the frames P2c's relay exchanges.
  const create = createPacket({
    operation: OpCode.OpCreateTcpTunnel,
    srcPort: 54321,
    dstPort: 8888,
    identifier: 1,
    source: 778899,
    payload: new Uint8Array(0),
  });
  assert.deepEqual(
    Buffer.from(create),
    Buffer.from([
      0x05, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x03, 0xd4, 0x31, 0x22, 0xb8, 0x00, 0x00, 0x00, 0x01, 0x00, 0x0b, 0xe2,
      0x93,
    ]),
  );
  const success = createPacket({
    operation: OpCode.OpTunnelSuccess,
    identifier: 1,
    source: 778899,
    payload: new Uint8Array(0),
  });
  assert.deepEqual(
    Buffer.from(success),
    Buffer.from([
      0x05, 0x00, 0x00, 0x14, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x0b, 0xe2,
      0x93,
    ]),
  );
  // Round-trip the create frame through the parser.
  const parsed = parsePacket(create);
  assert.equal(parsed.srcPort, 54321);
  assert.equal(parsed.dstPort, 8888);
  assert.equal(parsed.identifier, 1);
});

// The deploy-check output grammar, pinned from BOTH sides: the fake's
// synthesized vocabulary must parse through the product's own
// parseDeployCheckOutput (the extracted pure function), and a degraded
// variant must yield the incomplete verdict with the missing steps.

test('deploy-check grammar cross-tier pin: fake synthesis parses through the product parser', () => {
  const parsed = parseDeployCheckOutput(DEPLOY_CHECK_ALL_PASS);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.score, { pass: 6, total: 6 });
  assert.equal(parsed.publicUrl, 'https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com');
  assert.deepEqual(
    Object.keys(parsed.checks).sort((a, b) => a.localeCompare(b)),
    ['content_verified', 'devbridge_tunnel', 'nginx_serving', 'output_dir', 'qr_code', 'tunnel_url_accessible'],
  );
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.parseWarning, undefined);
});

test('deploy-check grammar pin: degraded output yields INCOMPLETE with the failing steps', () => {
  const degraded = DEPLOY_CHECK_ALL_PASS.replace('nginx_serving:PASS', 'nginx_serving:FAIL')
    .replace('SCORE:6/6', 'SCORE:5/6')
    .replace('VERDICT:COMPLETE', 'VERDICT:INCOMPLETE');
  const parsed = parseDeployCheckOutput(degraded);
  assert.equal(parsed.complete, false);
  assert.deepEqual(parsed.missing, ['nginx_serving']);
  assert.equal(parsed.score && parsed.score.pass < parsed.score.total, true);
});

test('deploy-check script recognition: the anchored first line dispatches to the synthesis', () => {
  // #999: the data-disk PATH export rides the same first line as the marker.
  const result = runShellCommand(
    'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "=== DEPLOY CHECK ==="\nTOTAL=0\n…',
    new FakeFs(),
  );
  assert.equal(result.intent, 'deploy-check-script');
  assert.equal(result.stdout, DEPLOY_CHECK_ALL_PASS);
  // The nginx presence probe answers INSTALLED — the product's real gate.
  const probe = runShellCommand('command -v nginx >/dev/null 2>&1 && echo "INSTALLED" || echo "MISSING"', new FakeFs());
  assert.equal(probe.intent, 'nginx-installed');
  assert.ok(probe.stdout.includes('INSTALLED'));
});

test('devbridge auth grammar cross-tier pin: fake synthesis parses through the product parser', () => {
  const parsed = parseDevbridgeAuthOutput(DEVBRIDGE_AUTH_KEYRING_STDOUT);
  assert.equal(parsed.authMode, 'API_KEY_KEYRING');
  assert.deepEqual(parsed.attempts, {});
});

test('devbridge expose grammar cross-tier pin: fake synthesis parses through the product parser', () => {
  const parsed = parseDevbridgeExposeOutput(DEVBRIDGE_EXPOSE_OK_STDOUT);
  assert.equal(parsed.tunnelUrl, 'https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.tunnelId, 'e2e-tunnel-1');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.quotaError, false);
  assert.equal(parsed.expiryHours, 72);
  assert.equal(parsed.gatewayTunnelError, false);
  assert.equal(parsed.badGateway, false);
  assert.equal(parsed.migration, false);
});

test('devbridge verify grammar cross-tier pin: fake synthesis parses through the product parser', () => {
  const parsed = parseDevbridgeVerifyOutput(DEVBRIDGE_VERIFY_OK_STDOUT);
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, false);
});

test('devbridge fake rows recognize the real scripts (first-line anchors)', () => {
  // The auth probe's first line is the double-quoted PATH export — unique
  // to the probe; the expose script and cleanup share the pkill first line.
  const fs = new FakeFs();
  // Builder-driven: the REAL auth probe's first line must stay recognizable —
  // a PATH-form change the fake no longer matches reds here instead of only
  // nightly (#999 moved the probe to the data-disk-first PATH).
  const auth = runShellCommand(
    buildDevbridgeAuthProbe().split('\n', 1)[0]! +
      '\nDB_OK=0\ndb_login_ok() { devbridge auth status 2>/dev/null | grep -q "Logged in"; }',
    fs,
  );
  assert.equal(auth.stdout, DEVBRIDGE_AUTH_KEYRING_STDOUT);
  // #999: the expose script (and the retry-cleanup blob) now opens with the
  // data-disk PATH export riding the same first line as the pkill — feed the
  // REAL builder so the anchor and the pin stay honest.
  const expose = runShellCommand(buildDevbridgeExposeScript(8080), fs);
  assert.equal(expose.stdout, DEVBRIDGE_EXPOSE_OK_STDOUT);
  const cleanup = runShellCommand(
    'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "devbridge host" 2>/dev/null || true; sleep 2; devbridge delete-all > /dev/null 2>&1 || true',
    fs,
  );
  assert.equal(cleanup.stdout, DEVBRIDGE_EXPOSE_OK_STDOUT);
  // The #998 version read-back one-shot — its own row, not the generic
  // export-path fall-through.
  const versionProbe = runShellCommand(
    'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "DB_VERSION=$(devbridge version 2>/dev/null | head -1)"',
    fs,
  );
  assert.equal(versionProbe.intent, 'devbridge-version-probe');
  assert.match(versionProbe.stdout, /DB_VERSION=0\.2\.2-release/);
  // The #919 re-verify script is built by the product's own builder — feed the
  // REAL script through the fake so the anchor and the pin stay honest.
  const verify = runShellCommand(buildDevbridgeVerifyScript('https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com'), fs);
  assert.equal(verify.intent, 'devbridge-verify-script');
  assert.equal(verify.stdout, DEVBRIDGE_VERIFY_OK_STDOUT);
  // The AUTO-ENROLL one-shots (the tunnel-persistence port) — builder-driven:
  // the read script's grep first line and the install script's #999
  // export-rides-the-pkill first line must hit their OWN rows, never the
  // auth-probe row (a standalone export first line is byte-identical to the
  // probe's — the misread made enrollment fail and taught the model to
  // retry, inflating the auth-probe count on both e2e legs).
  const keepaliveRead = runShellCommand(buildKeepaliveTunnelsReadScript(), fs);
  assert.equal(keepaliveRead.intent, 'devbridge-keepalive-read');
  assert.match(keepaliveRead.stdout, /^DB_KEEPALIVE_TUNNELS=$/m);
  const keepaliveInstall = runShellCommand(
    buildDevbridgeKeepaliveScript([
      { tunnelId: 'e2e-tunnel-1', url: 'https://e2e-tunnel-1-8080.devbridge-s2.hwtunnel.com' },
    ]),
    fs,
  );
  assert.equal(keepaliveInstall.intent, 'devbridge-keepalive-install');
  assert.match(keepaliveInstall.stdout, /DB_KEEPALIVE_SYNTAX=0/);
  assert.match(keepaliveInstall.stdout, /DB_KEEPALIVE_PID=\d+/);
  // deployNginx's tunnel-activity probe — the #999 first-line form (the PATH
  // export riding the subshell probe, verbatim from deploy-nginx.ts) must hit
  // its own row above the generic export-path fall-through.
  const tunnelProbe = runShellCommand(
    'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; (devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' || devbridge list 2>/dev/null | grep -Eq \'^[a-z2-7]{8}[[:space:]]\') && echo "ACTIVE" || echo "INACTIVE"',
    fs,
  );
  assert.equal(tunnelProbe.intent, 'devbridge-active');
  assert.equal(tunnelProbe.stdout, 'ACTIVE\n');
  // The connect flow's unquoted PATH export still hits the generic row,
  // not the auth-probe row.
  const plain = runShellCommand('export PATH=/workspace/.local/bin:$HOME/.huawei/bin${PATH:+:$PATH}', fs);
  assert.equal(plain.stdout, '');
});
