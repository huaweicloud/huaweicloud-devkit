import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  mergeKeepaliveTunnels,
  parseKeepaliveTunnelsOutput,
  renewTunnel,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import { exposeStdout, exposeViaSeam, healthyOneShot, verifyStdout, withAuthOk } from './devbridge-harness.ts';

test('#919: a URL that fails the fresh-session recheck is flagged non-persistent with the 请勿分享 warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(healthyOneShot(url, verifyStdout('000')), 8080, { keepalive: false });
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.equal(result.verifyHttpCode, '000');
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /访问链接将在会话结束后失效，请勿分享/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#922 B2: HTTP 200 with a "tunnel not found" body (native false-success) is non-persistent', async () => {
  const result = await exposeViaSeam(
    healthyOneShot('https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com', verifyStdout('200', '1')),
    8080,
    { keepalive: false },
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, '200');
  assert.equal(result.verifyNotFound, true);
  assert.equal(result.persistent, false);
  // The warning reports the ACTUAL recheck status (interpolated, not hardcoded).
  assert.match(result.warnings ?? '', /复测返回 HTTP 200/);
  assert.match(result.warnings ?? '', /原生假成功形态/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#919 primary death mode: a 404 verify with the not-found body is non-persistent, status honestly reported', async () => {
  // The host died between expose and verify → the fresh-session GET answers
  // 404 "tunnel not found". persistent must be false and the warning must say
  // HTTP 404 (the real status), never a hardcoded 200.
  const result = await exposeViaSeam(
    healthyOneShot('https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com', verifyStdout('404', '1')),
    8080,
    { keepalive: false },
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, '404');
  assert.equal(result.verifyNotFound, true);
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /复测返回 HTTP 404/);
  assert.doesNotMatch(result.warnings ?? '', /复测返回 HTTP 200/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#919: a verify exec that throws degrades to non-persistent (best-effort recheck)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(
    withAuthOk(async (command) => {
      if (command.startsWith('VERIFY_CODE=')) {
        throw new Error('fresh session died');
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, undefined);
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /请勿分享/);
});

test('mergeKeepaliveTunnels dedupes by id, incoming wins, order preserved (U16)', () => {
  const existing = [
    { tunnelId: 'aaaa1111', url: 'https://aaaa1111-80.devbridge-s2.hwtunnel.com' },
    { tunnelId: 'bbbb2222', url: 'https://bbbb2222-80.devbridge-s2.hwtunnel.com' },
  ];
  const incoming = [
    { tunnelId: 'bbbb2222', url: 'https://bbbb2222-81.devbridge-s2.hwtunnel.com' }, // refresh
    { tunnelId: 'cccc3333', url: 'https://cccc3333-80.devbridge-s2.hwtunnel.com' }, // new
  ];
  const merged = mergeKeepaliveTunnels(existing, incoming);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]!.tunnelId, 'aaaa1111');
  assert.equal(merged[1]!.url, 'https://bbbb2222-81.devbridge-s2.hwtunnel.com', 'incoming wins');
  assert.equal(merged[2]!.tunnelId, 'cccc3333');
  assert.deepEqual(mergeKeepaliveTunnels([], []), []);
});

test('parseKeepaliveTunnelsOutput: empty = no watchdog; entries parse (U16 + #946)', () => {
  assert.deepEqual(parseKeepaliveTunnelsOutput(''), []);
  assert.deepEqual(parseKeepaliveTunnelsOutput('DB_KEEPALIVE_TUNNELS='), []);
  const parsed = parseKeepaliveTunnelsOutput(
    '\x1b]133;C\x07DB_KEEPALIVE_TUNNELS=aaaa1111:https://aaaa1111-80.devbridge-s2.hwtunnel.com bbbb2222:https://bbbb2222-80.devbridge-s2.hwtunnel.com\r\n',
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.tunnelId, 'aaaa1111');
  assert.equal(parsed[1]!.url, 'https://bbbb2222-80.devbridge-s2.hwtunnel.com');
});

test('renewTunnel returns the parsed verdict end to end (U16 seam)', async () => {
  let renewScript = '';
  _setOneShotForTests(async (_ws, command) => {
    renewScript = command;
    return {
      stdout: 'DB_RENEW_EXIT=0\nDB_RENEW_ID=nv2dvv6w\nDB_RENEW_HOURS=720\nDB_EXPIRATION=1795022391\nDB_RENEW_ERROR=\n',
      exitCode: 0,
    };
  });
  let result;
  try {
    result = await renewTunnel('ws-u16', { tunnelId: 'nv2dvv6w', expiryHours: 720 });
  } finally {
    _setOneShotForTests(null);
  }
  assert.match(renewScript, /devbridge update nv2dvv6w -e 720/);
  assert.equal(result.ok, true);
  assert.equal(result.tunnelId, 'nv2dvv6w');
  assert.equal(result.expirationUnix, 1795022391);
});
