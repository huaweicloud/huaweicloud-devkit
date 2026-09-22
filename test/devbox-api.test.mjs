import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectFrame,
  decodeFrames,
  buildGatewayUrl,
  redactedConnection,
  sanitizeSecrets,
} from '../plugins/huaweicloud-core/src/sandbox/devbox-api.mjs';

test('connectFrame/decodeFrames round-trips a JSON payload', () => {
  const payload = { process: { cmd: '/bin/bash', args: ['-l', '-c', 'echo hi'] }, stdin: false };
  const framed = connectFrame(payload);
  assert.equal(framed[0], 0);
  assert.equal(framed.readUInt32BE(1), framed.length - 5);
  const decoded = decodeFrames(framed);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], payload);
});

test('decodeFrames parses a full Connect stream (start/data/end)', () => {
  const stdout1 = Buffer.from('hello\n').toString('base64');
  const stdout2 = Buffer.from('Linux 6.6.60 aarch64\n').toString('base64');
  const frames = [
    connectFrame({ event: { start: { pid: 78 } } }),
    connectFrame({ event: { data: { stdout: stdout1 } } }),
    connectFrame({ event: { data: { stdout: stdout2 } } }),
    connectFrame({ event: { end: { exited: true, status: 'exited' } } }),
  ];
  const decoded = decodeFrames(Buffer.concat(frames));
  assert.equal(decoded.length, 4);
  assert.equal(decoded[0].event.start.pid, 78);
  assert.equal(decoded[1].event.data.stdout, stdout1);
  assert.equal(decoded[3].event.end.exited, true);
});

test('buildGatewayUrl replaces {tunnel_id} and {port} from template', () => {
  const url = buildGatewayUrl(
    { domain: 'x.sandbox.devbox.local' },
    'https://{tunnel_id}-{port}.devbox-s2.hwtunnel.com',
    'abc123',
  );
  assert.equal(url, 'https://abc123-49983.devbox-s2.hwtunnel.com');
});

test('buildGatewayUrl falls back to domain when no template is set', () => {
  const url = buildGatewayUrl({ domain: 'https://sandbox1.example.com' }, '', 'ignored');
  assert.equal(url, 'https://sandbox1.example.com');
});

test('buildGatewayUrl rejects the .sandbox.devbox.local placeholder when no template', () => {
  assert.throws(
    () => buildGatewayUrl({ domain: 'https://abc.sandbox.devbox.local' }, '', 't1'),
    /placeholder EnvD endpoint/,
  );
});

test('redactedConnection never exposes the connect token', () => {
  const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.secret.signature';
  const conn = { sandboxId: 's1', tunnelId: 't1', connectToken: token, gatewayUrl: 'https://g', envdVersion: '0.2.5' };
  const redacted = redactedConnection(conn);
  assert.equal(redacted.connectToken, `eyJhbGci…(${token.length})`);
  assert.ok(!redacted.connectToken.includes(token));
  assert.ok(!JSON.stringify(redacted).includes(token));
});

test('redactedConnection returns null for no connection', () => {
  assert.equal(redactedConnection(null), null);
});

test('sanitizeSecrets strips token-like fields and redacts JWT strings', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.abc.def';
  const input = [
    {
      clientID: 'c1',
      connectToken: jwt,
      envdAccessToken: 'devbox-connection-token-placeholder',
      envdVersion: '0.2.5',
      nested: { foo: 'bar', token: 'short' },
    },
  ];
  const out = sanitizeSecrets(input);
  assert.ok(!JSON.stringify(out).includes(jwt));
  assert.equal(out[0].connectToken, `eyJhbG…(${jwt.length})`);
  assert.equal(out[0].envdAccessToken, `devbox…(${'devbox-connection-token-placeholder'.length})`);
  assert.equal(out[0].nested.token, '[redacted]');
  assert.equal(out[0].nested.foo, 'bar');
  assert.equal(out[0].clientID, 'c1');
  assert.equal(out[0].envdVersion, '0.2.5');
});
